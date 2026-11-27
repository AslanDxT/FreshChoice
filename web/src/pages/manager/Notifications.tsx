import { Archive, Bell, Megaphone, PaperPlaneTilt } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NotificationList } from '../../components/NotificationList';
import { Button, EmptyState, Field, Pill, Skeleton, Tabs, useToast } from '../../components/ui';
import { useBranch } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { instant } from '../../lib/time';

export default function Notifications() {
  const [tab, setTab] = useState<'notifications' | 'announcements'>('notifications');
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <h1>Notifications</h1>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'notifications', label: 'Notifications', icon: Bell },
          { value: 'announcements', label: 'Announcements', icon: Megaphone },
        ]}
      />
      {tab === 'notifications' ? <NotificationList manager /> : <Announcements />}
    </div>
  );
}

function Announcements() {
  const { branches, branchId } = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targets, setTargets] = useState<string[]>([branchId]);
  const [expires, setExpires] = useState('');
  const q = useQuery({ queryKey: ['announcements', 'manage'], queryFn: () => api.get<any[]>('/api/announcements?manage=true') });
  const post = useMutation({
    mutationFn: () => api.post('/api/announcements', { title, body, branchIds: targets, expiresAt: expires ? new Date(`${expires}T23:59:00`).toISOString() : null }),
    onSuccess: () => {
      toast.success('Announcement published', 'Employees of the selected branches were notified.');
      setTitle('');
      setBody('');
      setExpires('');
      void qc.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (e) => toast.error(e, 'Not published'),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/announcements/${id}/archive`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['announcements'] }),
    onError: (e) => toast.error(e),
  });
  return (
    <div className="stack lg">
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          post.mutate();
        }}
      >
        <h2>New announcement</h2>
        <Field label="Title" htmlFor="at">
          <input id="at" className="input" maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label="Message" htmlFor="ab">
          <textarea id="ab" className="textarea" maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        <div className="form-grid">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Show to employees of</legend>
            <div className="row wrap">
              {branches.map((b) => (
                <label key={b.id} className="check">
                  <input type="checkbox" checked={targets.includes(b.id)} onChange={(e) => setTargets(e.target.checked ? [...targets, b.id] : targets.filter((t) => t !== b.id))} />
                  {b.name}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Hide after (optional)" htmlFor="ae">
            <input id="ae" type="date" className="input" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <div className="row end">
          <Button variant="primary" type="submit" icon={PaperPlaneTilt} loading={post.isPending} disabled={!title.trim() || !body.trim() || !targets.length}>
            Publish
          </Button>
        </div>
      </form>
      <section className="stack">
        <h2>Published</h2>
        {q.isLoading ? (
          <Skeleton height={120} />
        ) : !q.data?.length ? (
          <EmptyState icon={Megaphone} title="No announcements yet">
            Announcements you publish appear on your employees' home page.
          </EmptyState>
        ) : (
          q.data.map((a) => (
            <article key={a.id} className="announcement">
              <div className="row between wrap">
                <strong>{a.title}</strong>
                <div className="row wrap" style={{ gap: 6 }}>
                  {a.targets.map((t: any) => (
                    <Pill key={t.branchId} tone="teal">{t.name}</Pill>
                  ))}
                  {a.archivedAt ? <Pill>Archived</Pill> : a.expiresAt && new Date(a.expiresAt) < new Date() ? <Pill>Expired</Pill> : <Pill tone="green">Visible</Pill>}
                </div>
              </div>
              <p>{a.body}</p>
              <div className="row between wrap" style={{ marginTop: 8 }}>
                <span className="subtle">
                  {a.author} · {instant(a.publishedAt)}
                </span>
                {a.canEdit && !a.archivedAt && (
                  <Button size="sm" variant="ghost" icon={Archive} onClick={() => archive.mutate(a.id)}>
                    Archive
                  </Button>
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
