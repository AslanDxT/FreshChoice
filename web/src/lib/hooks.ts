import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Skill {
  id: string;
  name: string;
  kind: 'skill' | 'qualification';
  description: string | null;
  colorIndex: number;
  isActive: boolean;
  holders: number;
}

export function useSkills() {
  return useQuery({ queryKey: ['skills'], queryFn: () => api.get<Skill[]>('/api/skills'), staleTime: 5 * 60_000 });
}

export function skillMap(skills: Skill[] | undefined) {
  return new Map((skills ?? []).map((s) => [s.id, s]));
}

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  date?: string;
  slot?: number;
  userId?: string;
  skillId?: string;
}

export interface WeekAssignment {
  id: string;
  userId: string;
  name: string;
  employeeNumber: string;
  date: string;
  slot: number;
  roleSkillId: string | null;
  primarySkill: string | null;
  status: 'active' | 'sick' | 'replaced';
  source: 'manual' | 'generated' | 'cover';
  cover: { id: string; status: string; kind: string } | null;
}

export interface WeekData {
  branchId: string;
  weekStart: string;
  dates: string[];
  templates: { slot: number; start: string; end: string }[];
  schedule: null | {
    id: string;
    status: 'draft' | 'published';
    revision: number;
    publishedRevision: number | null;
    publishedVersionNo: number | null;
    publishedAt: string | null;
    availabilityDeadline: string | null;
    hasUnpublishedChanges: boolean;
  };
  requirements: { date: string; slot: number; minStaff: number; skills: { skillId: string; minCount: number }[] }[];
  assignments: WeekAssignment[];
  breaks: { userId: string; date: string; start: string; end: string; minutes: number }[];
  coverage: { date: string; slot: number; assigned: number; minStaff: number; skills: { skillId: string; have: number; need: number }[]; ok: boolean }[];
  issues: Issue[];
  employees: { id: string; name: string; skills: string[]; weekWorkMinutes: number; contractWeeklyMinutes: number | null; availableCount: number; submitted: boolean }[];
  policy: { versionId: number; maxDailyWorkMinutes: number; staffingCountsBreaks: boolean };
}

export function useWeek(branchId: string, weekStart: string) {
  return useQuery({ queryKey: ['week', branchId, weekStart], queryFn: () => api.get<WeekData>(`/api/branches/${branchId}/weeks/${weekStart}`), enabled: !!branchId });
}

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
  interested: 'Interested',
  claimed: 'Claimed',
  withdrawn: 'Withdrawn',
  superseded: 'Closed',
};
