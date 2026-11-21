begin;

-- Keep the existing RPC signature, ownership, grants and transaction. Check
-- projections here as well as in the route because authenticated clients can call it.
create or replace function public.save_calculation_operation(
  p_operation_id uuid,
  p_mode text,
  p_request_hash text,
  p_calculation jsonb,
  p_history jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
  snapshot jsonb := p_calculation -> 'ai_insights';
  buckets jsonb := snapshot -> 'buckets';
  manual jsonb := snapshot -> 'manualExpenses';
  base numeric;
  profit numeric;
  tax numeric;
  rate numeric;
  cost numeric;
  net numeric;
  manual_total numeric;
  margin numeric;
  month text := snapshot #>> '{period,month}';
  common jsonb;
  bad_request constant jsonb := '{"ok":false,"reason":"bad_request"}'::jsonb;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if p_mode is distinct from 'upload'
     or snapshot ->> 'kind' is distinct from 'ozon-accrual-xlsx-v1'
     or snapshot -> 'preliminary' is distinct from 'false'::jsonb
     or snapshot #> '{costCoverage,complete}' is distinct from 'true'::jsonb
     or month is null or month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or jsonb_typeof(buckets) is distinct from 'object'
     or jsonb_typeof(manual) is distinct from 'object'
     or jsonb_typeof(p_history) is distinct from 'object'
  then
    return bad_request;
  end if;

  -- All money in the snapshot is signed integer kopecks, except rate and margin.
  if exists (
    select 1 from unnest(array[
      snapshot -> 'taxRevenueBaseKopecks', snapshot -> 'netProfitKopecks',
      snapshot -> 'productionCostKopecks', snapshot -> 'netOzonOperationsKopecks',
      snapshot -> 'salesRevenueKopecks', snapshot -> 'returnsRevenueKopecks',
      snapshot #> '{tax,kopecks}', manual -> 'totalKopecks',
      manual -> 'packagingKopecks', manual -> 'deliveryToWarehouseKopecks',
      manual -> 'salaryKopecks', manual -> 'otherKopecks',
      coalesce(manual -> 'adsOutsideOzonKopecks', '0'::jsonb),
      buckets -> 'salesRevenue', buckets -> 'returnsRevenue', buckets -> 'partnerPrograms',
      buckets -> 'discountPoints', buckets -> 'commission', buckets -> 'logistics',
      buckets -> 'advertising', buckets -> 'compensations', buckets -> 'other'
    ]) as values_to_check(v)
    where case when jsonb_typeof(v) = 'number'
      then v::numeric <> trunc(v::numeric) or abs(v::numeric) > 9007199254740991
      else true end
  ) or jsonb_typeof(snapshot #> '{tax,ratePercent}') is distinct from 'number'
    or jsonb_typeof(snapshot -> 'marginPercent') is distinct from 'number'
  then
    return bad_request;
  end if;

  base := (snapshot ->> 'taxRevenueBaseKopecks')::numeric;
  profit := (snapshot ->> 'netProfitKopecks')::numeric;
  tax := (snapshot #>> '{tax,kopecks}')::numeric;
  rate := (snapshot #>> '{tax,ratePercent}')::numeric;
  cost := (snapshot ->> 'productionCostKopecks')::numeric;
  net := (snapshot ->> 'netOzonOperationsKopecks')::numeric;
  manual_total := (manual ->> 'totalKopecks')::numeric;
  margin := (snapshot ->> 'marginPercent')::numeric;

  if base <= 0
     or base <> (buckets ->> 'salesRevenue')::numeric + (buckets ->> 'returnsRevenue')::numeric
     or snapshot -> 'salesRevenueKopecks' <> buckets -> 'salesRevenue'
     or snapshot -> 'returnsRevenueKopecks' <> buckets -> 'returnsRevenue'
     or net <> (
       select sum((buckets ->> name)::numeric) from unnest(array[
         'salesRevenue', 'returnsRevenue', 'partnerPrograms', 'discountPoints',
         'commission', 'logistics', 'advertising', 'compensations', 'other'
       ]) as known_buckets(name)
     )
     or rate < 0 or rate > 100 or rate <> round(rate, 2)
     or tax <> round(base * rate / 100)
     or exists (
       select 1 from unnest(array['packagingKopecks', 'deliveryToWarehouseKopecks',
                                  'salaryKopecks', 'otherKopecks', 'adsOutsideOzonKopecks'])
         as manual_fields(name)
       where (manual ->> name)::numeric < 0
     )
     or manual_total <> (
       select sum(coalesce((manual ->> name)::numeric, 0))
       from unnest(array['packagingKopecks', 'deliveryToWarehouseKopecks',
                         'salaryKopecks', 'otherKopecks', 'adsOutsideOzonKopecks'])
         as manual_fields(name)
     )
     or profit <> net - cost - tax - manual_total
     -- JavaScript Math.round rounds ties toward +infinity.
     or margin <> floor(profit * 10000 / base + 0.5) / 100
  then
    return bad_request;
  end if;

  common := jsonb_build_object('revenue', base / 100, 'profit', profit / 100, 'margin', margin);
  if not (p_calculation @> (common || jsonb_build_object(
    'marketplace', 'ozon', 'mode', 'upload',
    'commission', greatest(0, -(buckets ->> 'commission')::numeric) / 100,
    'logistics', greatest(0, -(buckets ->> 'logistics')::numeric) / 100,
    'ads', (greatest(0, -(buckets ->> 'advertising')::numeric)
            + coalesce((manual ->> 'adsOutsideOzonKopecks')::numeric, 0)) / 100,
    'storage', 0, 'tax', tax / 100, 'cost', cost / 100,
    'other_expenses', (
      greatest(0, -(buckets ->> 'other')::numeric)
      + manual_total - coalesce((manual ->> 'adsOutsideOzonKopecks')::numeric, 0)
    ) / 100,
    'total_expenses', (base - profit) / 100
  ))) or not (p_history @> (common || jsonb_build_object(
    'report_month', month || '-01', 'expenses', (base - profit) / 100
  ))) then
    return bad_request;
  end if;

  return public.calculation_operation_execute(
    caller, p_operation_id, 'upload', p_request_hash, p_calculation, p_history);
end;
$$;

commit;
