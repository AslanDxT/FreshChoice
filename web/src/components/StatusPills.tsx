import { CheckCircle, Clock, HourglassMedium, Prohibit, SealCheck, X, XCircle, CircleDashed, ArrowsClockwise } from '@phosphor-icons/react';
import { STATUS_LABEL } from '../lib/hooks';
import { Pill, type Tone } from './ui';

const COVER: Record<string, { tone: Tone; icon: any }> = {
  open: { tone: 'blue', icon: CircleDashed },
  pending: { tone: 'amber', icon: HourglassMedium },
  approved: { tone: 'green', icon: CheckCircle },
  rejected: { tone: 'red', icon: XCircle },
  cancelled: { tone: 'neutral', icon: Prohibit },
  completed: { tone: 'teal', icon: SealCheck },
  interested: { tone: 'blue', icon: Clock },
  claimed: { tone: 'amber', icon: HourglassMedium },
  withdrawn: { tone: 'neutral', icon: X },
  superseded: { tone: 'neutral', icon: Prohibit },
};

export function CoverStatus({ status }: { status: string }) {
  const c = COVER[status] ?? { tone: 'neutral', icon: CircleDashed };
  return (
    <Pill tone={c.tone} icon={c.icon}>
      {STATUS_LABEL[status] ?? status}
    </Pill>
  );
}

export function ScheduleStatus({ status, changed }: { status: 'draft' | 'published' | 'none'; changed?: boolean }) {
  if (status === 'none') return <Pill icon={CircleDashed}>No schedule yet</Pill>;
  if (status === 'draft') return <Pill tone="amber" icon={CircleDashed}>Draft, not published</Pill>;
  if (changed) return <Pill tone="purple" icon={ArrowsClockwise}>Published, with unpublished changes</Pill>;
  return <Pill tone="green" icon={SealCheck}>Published</Pill>;
}
