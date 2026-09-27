-- Platform admin console: suspending businesses, plans and limits, an overview across businesses.
ALTER TABLE "tenants"
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "status_changed_at" TIMESTAMPTZ(3);

-- The functions below cross businesses, so they are SECURITY DEFINER like the routing lookups.
-- Only the API's platform endpoints call them, after checking the caller is a platform owner.

-- Every business with what the operator needs to see (last 30 days of activity)
CREATE FUNCTION platform_tenants()
RETURNS TABLE (
  id uuid, name text, slug text, status text, status_reason text, status_changed_at timestamptz,
  plan text, country text, usage_limits jsonb, created_at timestamptz, owner_email text,
  members bigint, agents bigint, phone_numbers bigint, whatsapp_numbers bigint,
  calls_30d bigint, minutes_30d bigint, cost_micros_30d bigint, failed_jobs bigint, last_call_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name::text, t.slug::text, t.status::text, t.status_reason, t.status_changed_at,
    t.plan::text, t.country::text, t.usage_limits, t.created_at,
    (SELECT u.email::text FROM memberships m JOIN roles r ON r.id = m.role_id AND r.key = 'OWNER'
       JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id ORDER BY m.created_at LIMIT 1),
    (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id),
    (SELECT count(*) FROM agents a WHERE a.tenant_id = t.id),
    (SELECT count(*) FROM phone_numbers p WHERE p.tenant_id = t.id AND p.is_active),
    (SELECT count(*) FROM whatsapp_numbers w WHERE w.tenant_id = t.id AND w.status <> 'DISCONNECTED'),
    (SELECT count(*) FROM calls c WHERE c.tenant_id = t.id AND c.started_at > now() - interval '30 days'),
    (SELECT coalesce(sum(ceil(c.duration_sec / 60.0)), 0)::bigint FROM calls c
       WHERE c.tenant_id = t.id AND c.started_at > now() - interval '30 days'),
    (SELECT coalesce(sum(u.cost_micros), 0)::bigint FROM usage_records u
       WHERE u.tenant_id = t.id AND u.created_at > now() - interval '30 days'),
    (SELECT count(*) FROM failed_jobs f WHERE f.tenant_id = t.id AND f.status = 'FAILED'),
    (SELECT max(c.started_at) FROM calls c WHERE c.tenant_id = t.id)
  FROM tenants t
  WHERE t.status <> 'DELETED'
  ORDER BY t.created_at DESC
$$;

-- Suspend or reactivate: suspended businesses get no calls, messages, sign-ins or API access
CREATE FUNCTION platform_set_tenant_status(p_tenant uuid, p_status text, p_reason text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'status must be ACTIVE or SUSPENDED';
  END IF;
  UPDATE tenants SET status = p_status::"TenantStatus", status_reason = p_reason,
    status_changed_at = now(), updated_at = now()
    WHERE id = p_tenant AND status <> 'DELETED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION platform_set_tenant_plan(p_tenant uuid, p_plan text, p_limits jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  UPDATE tenants SET plan = p_plan, usage_limits = p_limits, updated_at = now()
    WHERE id = p_tenant AND status <> 'DELETED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Sign-in: a suspended business this user belongs to (to say so, instead of "not a member")
CREATE FUNCTION user_suspended_business(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.name::text FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND t.status = 'SUSPENDED' LIMIT 1
$$;

REVOKE ALL ON FUNCTION platform_tenants(), platform_set_tenant_status(uuid, text, text),
  platform_set_tenant_plan(uuid, text, jsonb), user_suspended_business(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenants(), platform_set_tenant_status(uuid, text, text),
  platform_set_tenant_plan(uuid, text, jsonb), user_suspended_business(uuid) TO app_user;
