import { describe, expect, it } from 'vitest';
import { attendanceReport, segmentRelativePath, shouldStopForEmpty } from '../src/domain/recording.js';
import { planJobs } from '../src/domain/reminders.js';

const t = (hhmm: string) => new Date(`2026-10-15T${hhmm}:00Z`);

describe('segmentRelativePath', () => {
  it('dossier par personne, nom triable', () => {
    expect(segmentRelativePath('123', 4500)).toBe('123/000004500.ogg');
    expect(['123/000010000.ogg', segmentRelativePath('123', 9999)].sort()[0]).toBe('123/000009999.ogg');
  });
});

describe('shouldStopForEmpty', () => {
  const base = { meetingStartsAt: t('18:00'), graceMin: 5 };
  it('bot arrivé en avance, seul : pas d’arrêt avant le début + délai', () => {
    expect(shouldStopForEmpty({ ...base, humansPresent: 0, lastHumanAt: null, now: t('17:59') })).toBe(false);
    expect(shouldStopForEmpty({ ...base, humansPresent: 0, lastHumanAt: null, now: t('18:04') })).toBe(false);
    expect(shouldStopForEmpty({ ...base, humansPresent: 0, lastHumanAt: null, now: t('18:05') })).toBe(true);
  });
  it('dernier participant parti : délai à partir de son départ', () => {
    expect(shouldStopForEmpty({ ...base, humansPresent: 0, lastHumanAt: t('18:40'), now: t('18:44') })).toBe(false);
    expect(shouldStopForEmpty({ ...base, humansPresent: 0, lastHumanAt: t('18:40'), now: t('18:45') })).toBe(true);
  });
  it('quelqu’un est là : jamais', () => {
    expect(shouldStopForEmpty({ ...base, humansPresent: 1, lastHumanAt: t('10:00'), now: t('23:00') })).toBe(false);
  });
});

describe('attendanceReport', () => {
  const rsvps = [
    { userId: 'a', status: 'yes' as const },
    { userId: 'b', status: 'yes' as const },
    { userId: 'c', status: 'maybe' as const },
    { userId: 'd', status: 'no' as const },
  ];
  const presence = [
    { userId: 'a', joinedAt: t('18:00'), leftAt: t('18:30'), excluded: false },
    { userId: 'a', joinedAt: t('18:40'), leftAt: null, excluded: false }, // revenu
    { userId: 'c', joinedAt: t('18:10'), leftAt: t('18:20'), excluded: true },
    { userId: 'd', joinedAt: t('18:05'), leftAt: null, excluded: false },
    { userId: 'e', joinedAt: t('18:00'), leftAt: t('18:01'), excluded: false },
  ];
  const report = attendanceReport(rsvps, presence, t('19:00'));

  it('déclarés vs réels', () => {
    expect(report.came).toEqual(['a', 'c']);
    expect(report.noShow).toEqual(['b']);
    expect(report.unannounced).toEqual(['d', 'e']); // d avait dit « absent »
    expect(report.notRecorded).toEqual(['c']);
  });
  it('temps de présence cumulé (passages multiples, présence en cours à la fin)', () => {
    expect(report.presenceMs.get('a')).toBe((30 + 20) * 60_000);
    expect(report.presenceMs.get('d')).toBe(55 * 60_000);
  });
});

describe('planJobs + enregistrement auto', () => {
  const meeting = { startsAt: t('18:00'), durationMin: 60, status: 'scheduled' as const, autoRecord: true };
  it('le bot rejoint en avance', () => {
    const jobs = planJobs(meeting, [], t('10:00'), 2);
    expect(jobs.map((j) => [j.kind, j.dueAt.toISOString()])).toEqual([
      ['record_start', t('17:58').toISOString()],
      ['start', t('18:00').toISOString()],
      ['auto_end', t('21:00').toISOString()],
    ]);
  });
  it('sans enregistrement auto : pas d’échéance', () => {
    expect(planJobs({ ...meeting, autoRecord: false }, [], t('10:00'), 2).some((j) => j.kind === 'record_start')).toBe(false);
  });
  it('création tardive : démarrage immédiat', () => {
    const now = t('17:59');
    expect(planJobs(meeting, [], now, 2).find((j) => j.kind === 'record_start')!.dueAt).toEqual(now);
  });
});
