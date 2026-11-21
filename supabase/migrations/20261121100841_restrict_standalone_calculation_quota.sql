begin;

-- The atomic save RPCs call the internal quota functions. Retire direct access
-- to the old wrappers, including Supabase's explicit role grants.
revoke execute on function public.consume_calculation(), public.consume_api_calculation()
  from public, anon, authenticated, service_role;

commit;
