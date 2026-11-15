-- Requires 20261113221918_quota_atomic_edits.sql (calculations.edit_version).
-- Return the actual version WITH the saved snapshot in creation, replay and
-- status responses. No data, quota rules, payload hashes or financial values change.
begin;

create or replace function public.calculation_operation_saved(p_calculation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'user_id', c.user_id, 'created_at', c.created_at,
    'edit_version', c.edit_version,
    'marketplace', c.marketplace, 'mode', c.mode,
    'revenue', c.revenue, 'commission', c.commission, 'logistics', c.logistics,
    'ads', c.ads, 'storage', c.storage, 'tax', c.tax, 'cost', c.cost,
    'other_expenses', c.other_expenses, 'total_expenses', c.total_expenses,
    'profit', c.profit, 'margin', c.margin,
    'ai_score', c.ai_score, 'ai_insights', c.ai_insights
  )
  from public.calculations c
  where c.id = p_calculation_id;
$$;

-- Remains an internal helper: only the existing owner-checked RPCs call it.
revoke all on function public.calculation_operation_saved(uuid) from public, anon, authenticated, service_role;
commit;

notify pgrst, 'reload schema';
