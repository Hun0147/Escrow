'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Dispute, KycRecord } from '@escrow/shared';
import { api } from '../../lib/api';
import { formatCents, relativeTime } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Empty, SectionTitle, Spinner } from '../../components/ui';

interface Dashboard {
  matches: Record<string, number>;
  disputes: Record<string, number>;
  ocrJobs: Record<string, number>;
  platformRevenueCents: number;
  escrowHeldCents: number;
  reconciliationBreaks: { userId: string; field: string; walletCents: number; expectedCents: number }[];
  openFraudFlags: { id: string; userId: string; kind: string; detail: string; createdAt: string }[];
}

export default function AdminPage() {
  const { user, loading } = useRequireSession();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [kyc, setKyc] = useState<KycRecord[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!user || user.role === 'player') return;
    void api<Dashboard>('/admin/dashboard').then(setDashboard);
    void api<{ disputes: Dispute[] }>('/disputes?status=open').then((data) => setDisputes(data.disputes));
    void api<{ pending: KycRecord[] }>('/admin/kyc').then((data) => setKyc(data.pending));
  }, [user]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  if (user.role === 'player') {
    return (
      <AppShell>
        <Empty title="Staff only" hint="This area is for moderators and admins." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-4 font-display text-2xl font-black">Operations</h1>

      {notice ? <div className="mb-3"><Banner tone="good">{notice}</Banner></div> : null}

      {dashboard ? (
        <>
          {dashboard.reconciliationBreaks.length > 0 ? (
            <div className="mb-3">
              <Banner tone="danger">
                {dashboard.reconciliationBreaks.length} wallet(s) disagree with the ledger. Stop
                payouts and investigate — this should never be non-zero.
              </Banner>
            </div>
          ) : (
            <div className="mb-3">
              <Banner tone="good">Ledger and wallets reconcile exactly.</Banner>
            </div>
          )}

          <div className="mb-4 grid grid-cols-2 gap-2">
            <Tile label="Held in escrow" value={formatCents(dashboard.escrowHeldCents)} />
            <Tile label="Platform revenue" value={formatCents(dashboard.platformRevenueCents)} tone="text-volt" />
            <Tile label="Open disputes" value={String(dashboard.disputes.open ?? 0)} tone="text-danger" />
            <Tile label="OCR queued" value={String(dashboard.ocrJobs.pending ?? 0)} />
          </div>

          <div className="mb-4 flex gap-2">
            <button
              className="btn-ghost flex-1"
              onClick={async () => {
                const result = await api<{ processed: number }>('/admin/jobs/ocr', { body: {} });
                setNotice(`Processed ${result.processed} screenshot(s).`);
              }}
            >
              Run OCR queue
            </button>
            <button
              className="btn-ghost flex-1"
              onClick={async () => {
                const result = await api<{ escalated: string[] }>('/admin/jobs/sweep-deadlines', { body: {} });
                setNotice(`Escalated ${result.escalated.length} lapsed match(es).`);
              }}
            >
              Sweep deadlines
            </button>
          </div>
        </>
      ) : (
        <Spinner />
      )}

      <SectionTitle>Dispute queue</SectionTitle>
      {disputes.length === 0 ? (
        <Empty title="Queue is clear" hint="Nothing is waiting on a human right now." />
      ) : (
        <ul className="mb-4 space-y-2">
          {disputes.map((dispute) => (
            <li key={dispute.id}>
              <Link href={`/admin/disputes/${dispute.id}`} className="card block hover:border-volt/50">
                <p className="text-sm font-semibold">{dispute.reason}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Opened {relativeTime(dispute.createdAt)} ·{' '}
                  {dispute.raisedBy ? 'raised by a player' : 'auto-escalated'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>KYC waiting for review</SectionTitle>
      {kyc.length === 0 ? (
        <Empty title="No pending verifications" />
      ) : (
        <ul className="mb-4 space-y-2">
          {kyc.map((record) => (
            <li key={record.id} className="card">
              <p className="text-sm font-semibold">{record.documentType.replace('_', ' ')}</p>
              <p className="text-xs text-slate-500">
                {record.addressCountry}
                {record.addressRegion ? `-${record.addressRegion}` : ''} · {relativeTime(record.createdAt)}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  className="btn-primary"
                  onClick={async () => {
                    await api(`/admin/kyc/${record.id}`, { body: { approve: true } });
                    setKyc((current) => current.filter((item) => item.id !== record.id));
                    setNotice('Verification approved.');
                  }}
                >
                  Approve
                </button>
                <button
                  className="btn-danger"
                  onClick={async () => {
                    await api(`/admin/kyc/${record.id}`, {
                      body: { approve: false, rejectionReason: 'Documents unreadable' },
                    });
                    setKyc((current) => current.filter((item) => item.id !== record.id));
                    setNotice('Verification rejected.');
                  }}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Open fraud flags</SectionTitle>
      {!dashboard || dashboard.openFraudFlags.length === 0 ? (
        <Empty title="Nothing flagged" />
      ) : (
        <ul className="space-y-2">
          {dashboard.openFraudFlags.map((flag) => (
            <li key={flag.id} className="card py-3">
              <p className="text-sm font-semibold text-warn">{flag.kind.replace(/_/g, ' ')}</p>
              <p className="text-xs text-slate-400">{flag.detail}</p>
              <p className="mt-1 text-[11px] text-slate-500">{relativeTime(flag.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

function Tile({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card py-3">
      <p className={`font-display text-xl font-black tabular-nums ${tone}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  );
}
