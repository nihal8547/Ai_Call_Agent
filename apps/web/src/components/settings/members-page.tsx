"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CreateInvitationBody } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type z } from "zod";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { applyServerErrors } from "@/lib/forms";
import { fmtDate, type Invitation, type Member, type Page, type Role } from "./types";

export function MembersPage() {
  const me = useMe();
  const canWrite = useCan("users:write");
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string; link?: string } | null>(
    null,
  );

  const members = useQuery({ queryKey: ["members"], queryFn: () => api<Page<Member>>("/members?limit=100") });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<{ items: Role[] }>("/roles"),
    enabled: useCan("roles:read"),
  });
  const invites = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api<{ items: Invitation[] }>("/invitations"),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) =>
      api(`/members/${id}`, { method: "PATCH", body: { roleId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
    onError: (e) => setNotice({ tone: "error", text: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/members/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
    onError: (e) => setNotice({ tone: "error", text: errorMessage(e) }),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api(`/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations"] }),
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="People who can sign in to this business and what they can do."
      />
      {notice ? (
        <div className="mb-4">
          <Alert tone={notice.tone}>
            {notice.text}
            {notice.link ? (
              <input
                readOnly
                value={notice.link}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Invitation link"
                className="mt-2 block w-full rounded border border-current/30 bg-transparent px-2 py-1 font-mono text-xs"
              />
            ) : null}
          </Alert>
        </div>
      ) : null}

      {canWrite && roles.data ? (
        <InviteForm
          roles={roles.data.items}
          onInvited={(email, link) => {
            setNotice({
              tone: "success",
              text: `Invitation created for ${email}. Share this link with them (it is shown only once):`,
              link,
            });
            void qc.invalidateQueries({ queryKey: ["invitations"] });
          }}
        />
      ) : null}

      <Card className="mt-6 overflow-x-auto p-0">
        {members.isLoading ? <p className="p-6 text-sm text-slate-500">Loading…</p> : null}
        {members.error ? (
          <div className="p-6">
            <Alert>{errorMessage(members.error)}</Alert>
          </div>
        ) : null}
        {members.data ? (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Last sign-in</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {members.data.items.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="px-4 py-3">
                    <p className="font-medium">
                      {m.user.name}
                      {m.user.id === me.user.id ? <span className="text-slate-400"> (you)</span> : null}
                    </p>
                    <p className="text-slate-500">{m.user.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    {canWrite && roles.data ? (
                      <select
                        aria-label={`Role for ${m.user.name}`}
                        value={m.role.id}
                        disabled={changeRole.isPending}
                        onChange={(e) => changeRole.mutate({ id: m.id, roleId: e.target.value })}
                        className="h-9 rounded-lg border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                      >
                        {roles.data.items.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge>{m.role.name}</Badge>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 md:table-cell">
                    {fmtDate(m.user.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canWrite && m.user.id !== me.user.id ? (
                      <Button
                        variant="ghost"
                        onClick={() => confirm(`Remove ${m.user.name}?`) && remove.mutate(m.id)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>

      {invites.data?.items.length ? (
        <Card className="mt-6">
          <h2 className="font-semibold">Pending invitations</h2>
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {invites.data.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {i.email} · <Badge>{i.role.name}</Badge>{" "}
                  <span className="text-slate-500">expires {fmtDate(i.expiresAt)}</span>
                </span>
                {canWrite ? (
                  <Button variant="ghost" onClick={() => revokeInvite.mutate(i.id)}>
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

type InviteValues = z.input<typeof CreateInvitationBody>;

function InviteForm({
  roles,
  onInvited,
}: {
  roles: Role[];
  onInvited: (email: string, link: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<InviteValues>({
    resolver: zodResolver(CreateInvitationBody),
    defaultValues: { email: "", roleId: roles.find((r) => r.key === "STAFF")?.id ?? roles[0]?.id ?? "" },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<{ email: string; inviteUrl: string }>("/invitations", {
        method: "POST",
        body: values,
      });
      form.reset({ email: "", roleId: values.roleId });
      onInvited(res.email, res.inviteUrl);
    } catch (err) {
      if (!applyServerErrors(err, form.setError)) setError(errorMessage(err));
    }
  });
  return (
    <Card>
      <h2 className="font-semibold">Invite someone</h2>
      <form
        onSubmit={onSubmit}
        noValidate
        className="mt-4 grid gap-4 sm:grid-cols-[1fr_200px_auto] sm:items-start"
      >
        <TextField
          label="Email"
          type="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <SelectField label="Role" error={form.formState.errors.roleId?.message} {...form.register("roleId")}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </SelectField>
        <Button type="submit" className="sm:mt-6" loading={form.formState.isSubmitting}>
          Send invite
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
