-- P1: only metered operations create calculations; edits preserve the original
-- source and update the linked history row atomically, without consuming quota.
-- Apply manually ONLY after approval, together with the matching API release.
-- No historical data is rewritten, inferred, deleted or charged by this migration.
begin;

-- Defense in depth: privileges AND restrictive policies. Column grants are
-- independent of table grants, so revoke both (including PUBLIC inheritance).
do $$
declare t text; c record;
begin
  foreach t in array array['calculations', 'report_history'] loop
    execute format('revoke insert, update, truncate, references, trigger on public.%I from public, anon, authenticated', t);
    for c in select attname from pg_attribute
      where attrelid = ('public.' || t)::regclass and attnum > 0 and not attisdropped loop
      execute format('revoke insert (%I), update (%I), references (%I) on public.%I from public, anon, authenticated', c.attname, c.attname, c.attname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_no_direct_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to public with check (false)', t || '_no_direct_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_no_direct_update', t);
    execute format('create policy %I on public.%I as restrictive for update to public using (false) with check (false)', t || '_no_direct_update', t);
  end loop;
end $$;

-- A projection of immutable XLSX source facts. Only expenses, catalogue costs
-- and their derived allocations/results may change. Period, products, quantities,
-- revenues, Ozon operations and source metadata remain bound to the paid operation.
create or replace function public.calculation_edit_source(s jsonb)
returns jsonb language sql immutable strict security invoker
set search_path = pg_catalog, pg_temp
as $$
  select (s - array['generatedAt','productionCostKopecks','costCoverage','tax',
    'manualExpenses','netProfitKopecks','marginPercent','preliminary','productTotals',
    'reconciliation','products']) || jsonb_build_object('products', (
      select coalesce(jsonb_agg(
        (p - array['allocatedTaxKopecks','allocatedManualKopecks','unitCost','matched',
          'hasCost','cogsKopecks','profitKopecks','marginPercent','split']) ||
        case when p ? 'split' then jsonb_build_object('split', (
          select jsonb_object_agg(k, case
            when k = 'parts' then (select jsonb_object_agg(part, val - array['cogsKopecks','taxKopecks','manualKopecks']) from jsonb_each(v) as parts(part,val))
            else v end)
          from jsonb_each(p->'split') as split(k,v)
          where k not in ('unsplitUpKopecks','unsplitDownKopecks')
        )) else '{}'::jsonb end
        order by n), '[]'::jsonb)
      from jsonb_array_elements(s->'products') with ordinality as products(p,n)
    ));
$$;
revoke all on function public.calculation_edit_source(jsonb) from public, anon, authenticated;
grant execute on function public.calculation_edit_source(jsonb) to service_role;

create or replace function public.edit_calculation_operation(
  p_user_id uuid, p_calculation_id uuid, p_calculation jsonb, p_history jsonb
)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  c public.calculations%rowtype;
  op public.calculation_operations%rowtype;
  h public.report_history%rowtype;
  source_before jsonb;
  source_after jsonb;
begin
  -- Also fail closed if EXECUTE is accidentally granted to a browser role.
  if current_user <> 'service_role' then
    raise insufficient_privilege using message = 'server-only calculation edit';
  end if;
  if p_user_id is null or p_calculation_id is null
     or jsonb_typeof(p_calculation) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  -- Same lock order as creation/replay: profile, calculation, operation, history.
  perform 1 from public.profiles where id = p_user_id for update;
  select * into c from public.calculations
    where id = p_calculation_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if c.mode = 'api' then return jsonb_build_object('ok', false, 'reason', 'api_mode_forbidden'); end if;
  if (select count(*) from public.calculation_operations where calculation_id = c.id) <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'legacy_read_only');
  end if;
  select * into op from public.calculation_operations
    where calculation_id = c.id and user_id = p_user_id and mode = c.mode for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'legacy_read_only'); end if;
  if p_calculation->>'marketplace' is distinct from c.marketplace
     or (p_calculation ? 'mode' and p_calculation->>'mode' is distinct from c.mode)
     or (p_calculation->>'revenue')::numeric is distinct from c.revenue then
    return jsonb_build_object('ok', false, 'reason', 'source_conflict');
  end if;
  if c.mode = 'upload' then
    -- Historical UPD snapshots cannot be converted to a new XLSX operation.
    if c.ai_insights->>'kind' is distinct from 'ozon-accrual-xlsx-v1'
       or p_calculation->'ai_insights'->>'kind' is distinct from 'ozon-accrual-xlsx-v1' then
      return jsonb_build_object('ok', false, 'reason', 'legacy_read_only');
    end if;
    source_before := public.calculation_edit_source(c.ai_insights);
    source_after := public.calculation_edit_source(p_calculation->'ai_insights');
    if source_before is distinct from source_after then
      return jsonb_build_object('ok', false, 'reason', 'source_conflict');
    end if;
    select * into h from public.report_history
      where id = op.report_history_id and user_id = p_user_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'history_missing'); end if;
    -- Never touch a row shared with another operation, even in damaged history.
    if (select count(*) from public.calculation_operations where report_history_id = h.id) <> 1 then
      return jsonb_build_object('ok', false, 'reason', 'history_missing');
    end if;
    if jsonb_typeof(p_history) is distinct from 'object'
       or (p_history->>'report_month')::date is distinct from h.report_month then
      return jsonb_build_object('ok', false, 'reason', 'source_conflict');
    end if;
  elsif c.mode <> 'manual' or p_history is not null or p_calculation ? 'ai_insights' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  update public.calculations set
    commission = (p_calculation->>'commission')::numeric,
    logistics = (p_calculation->>'logistics')::numeric,
    ads = (p_calculation->>'ads')::numeric,
    storage = (p_calculation->>'storage')::numeric,
    tax = (p_calculation->>'tax')::numeric,
    cost = (p_calculation->>'cost')::numeric,
    other_expenses = (p_calculation->>'other_expenses')::numeric,
    total_expenses = (p_calculation->>'total_expenses')::numeric,
    profit = (p_calculation->>'profit')::numeric,
    margin = (p_calculation->>'margin')::numeric,
    ai_insights = case when c.mode = 'upload' then p_calculation->'ai_insights' else c.ai_insights end
    where id = c.id returning * into c;
  if c.mode = 'upload' then
    update public.report_history set
      revenue = c.revenue, expenses = c.total_expenses, profit = c.profit, margin = c.margin
      where id = h.id;
  end if;
  -- Replay must return the edited snapshot, never silently restore original costs.
  update public.calculation_operations set payload_hash = encode(sha256(convert_to(jsonb_build_object(
    'calculation', p_calculation - 'ai_insights',
    'snapshot', (p_calculation->'ai_insights') - 'generatedAt' - 'savedAt',
    'history', p_history
  )::text, 'UTF8')), 'hex') where id = op.id;
  return jsonb_build_object('ok', true, 'calculation', to_jsonb(c));
end;
$$;
revoke all on function public.edit_calculation_operation(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.edit_calculation_operation(uuid,uuid,jsonb,jsonb) to service_role;
commit;
