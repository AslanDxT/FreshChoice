/**
 * Actions for a confirmed shift: Call Sick (yellow) and Find Cover (purple, opens the Find
 * Cover page with a Grow Morph transition that starts from the button).
 */
import { CheckCircle, FirstAidKit, HandHeart } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, Modal, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { fullDate, shiftTime } from '../../lib/time';

export interface ConfirmedShift {
  assignmentId: string;
  date: string;
  slot: number;
  branchName?: string;
  role?: string | null;
  coverStatus?: string | null;
}

export function ShiftActionModal({ shift, onClose }: { shift: ConfirmedShift | null; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'choose' | 'sick' | 'done'>('choose');
  const [restOfDay, setRestOfDay] = useState(true);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const sick = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/me/sickness', { assignmentId: shift!.assignmentId, includeRestOfDay: restOfDay, note: note || undefined }),
    onSuccess: (r) => {
      setMessage(r.message);
      setMode('done');
      for (const k of ['my-shifts', 'my-availability', 'my-home', 'my-cover']) void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => toast.error(e, 'Sickness not reported'),
  });
  const close = () => {
    setMode('choose');
    setNote('');
    onClose();
  };
  if (!shift) return null;
  const pending = shift.coverStatus === 'open' || shift.coverStatus === 'pending';

  const goCover = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pct = (v: number, total: number) => `${Math.max(0, Math.min(100, (v / total) * 100)).toFixed(2)}%`;
    const growFrom = { top: pct(r.top, vh), right: pct(vw - r.right, vw), bottom: pct(vh - r.bottom, vh), left: pct(r.left, vw) };
    close();
    nav('/my/cover', { state: { assignmentId: shift.assignmentId, growFrom } });
  };

  return (
    <Modal
      open
      onClose={close}
      title={mode === 'done' ? 'Sickness reported' : 'Your confirmed shift'}
      description={mode === 'done' ? undefined : `${fullDate(shift.date)} · ${shiftTime(shift.slot)}${shift.branchName ? ` · ${shift.branchName}` : ''}${shift.role ? ` · ${shift.role}` : ''}`}
    >
      {mode === 'choose' && (
        <div className="stack">
          <button className="choice yellow" onClick={() => setMode('sick')}>
            <span className="ico"><FirstAidKit size={24} /></span>
            <span>
              Call Sick
              <small>Tell your manager you cannot work because you are ill</small>
            </span>
          </button>
          <button className="choice purple" onClick={goCover} disabled={pending} aria-describedby={pending ? 'cover-pending' : undefined}>
            <span className="ico"><HandHeart size={24} /></span>
            <span>
              Find Cover
              <small>{pending ? 'You already asked for cover for this shift' : 'Ask a colleague to take this shift'}</small>
            </span>
          </button>
          {pending && <p id="cover-pending" className="subtle">See the status on the Find Cover page.</p>}
          <div className="row end">
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'sick' && (
        <div className="stack">
          <p>Your manager is notified straight away and looks for a replacement. You do not need to share any medical details.</p>
          <label className="check">
            <input type="checkbox" checked={restOfDay} onChange={(e) => setRestOfDay(e.target.checked)} />
            Also report my other shifts on this day
          </label>
          <Field label="Practical note for your manager (optional)" htmlFor="snote" hint="For example when you expect to be back. Please do not include a diagnosis.">
            <textarea id="snote" className="textarea" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => setMode('choose')}>Back</Button>
            <Button className="choice yellow" style={{ minHeight: 44, width: 'auto', fontSize: 15 }} loading={sick.isPending} onClick={() => sick.mutate()} icon={FirstAidKit}>
              Report sick
            </Button>
          </div>
        </div>
      )}
      {mode === 'done' && (
        <div className="stack">
          <div className="banner" role="status">
            <CheckCircle size={24} style={{ flex: 'none' }} />
            <span>{message}</span>
          </div>
          <p className="muted">What happens next: your manager acknowledges the report and arranges a replacement. The shift now shows as sick in your schedule. Get well soon.</p>
          <div className="row end"><Button variant="primary" onClick={close}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}
