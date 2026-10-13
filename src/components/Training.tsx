import { ArrowRight, CheckCircle2, GraduationCap, Rocket, ShieldCheck, Zap } from 'lucide-react';
import type { GameAction } from '../types';
import { t } from '../i18n';
import './training.css';

export interface TrainingLesson {
  id: string;
  title: string;
  summary: string;
  duration: string;
}

export interface TrainingProgress {
  lessonId: string;
  title: string;
  step: number;
  totalSteps: number;
  instruction: string;
  status: 'active' | 'complete';
  allowedActions: Pick<GameAction, 'type' | 'cardId' | 'arg'>[];
  nextLessonId?: string;
}

interface TrainingSelectorProps {
  lessons: TrainingLesson[];
  onStart: (lessonId: string) => void;
  busy?: boolean;
  completedLessonIds?: string[];
}

const lessonIcons = { resources: Zap, 'space-ambush': Rocket, 'leader-deploy': ShieldCheck };

export function TrainingSelector({ lessons, onStart, busy = false, completedLessonIds = [] }: TrainingSelectorProps) {
  return <section className="training-selector" aria-labelledby="training-title">
    <div className="training-heading">
      <GraduationCap size={21} aria-hidden="true" />
      <div><h2 id="training-title">{t('Training missions')}</h2>
        <p>{t('Learn one rule at a time on a real battlefield. Follow the highlighted choices.')}</p></div>
    </div>
    <div className="training-lessons">
      {lessons.map((lesson, index) => {
        const Icon = lessonIcons[lesson.id as keyof typeof lessonIcons] || GraduationCap;
        return <article className="training-lesson" key={lesson.id}>
          <div className="training-lesson-top"><Icon size={18} aria-hidden="true" />
            <span>{t('Lesson {number}', { number: index + 1 })}</span><small>{t(lesson.duration)}</small></div>
          <h3>{t(lesson.title)}</h3>
          {completedLessonIds.includes(lesson.id) && <span className="training-lesson-completed">
            <CheckCircle2 size={13} aria-hidden="true" /><span>{t('Completed')}</span>
          </span>}
          <p>{t(lesson.summary)}</p>
          <button type="button" className="training-start" disabled={busy}
            onClick={() => onStart(lesson.id)} aria-label={t('Start lesson: {title}', { title: t(lesson.title) })}>
            <span>{t('Start lesson')}</span><ArrowRight size={16} aria-hidden="true" />
          </button>
        </article>;
      })}
    </div>
  </section>;
}

interface TrainingGuidanceProps {
  training: TrainingProgress;
  onExit: () => void;
  onNext: (lessonId: string) => void;
  busy?: boolean;
}

export function TrainingGuidance({ training, onExit, onNext, busy = false }: TrainingGuidanceProps) {
  const complete = training.status === 'complete';
  return <section className={`training-guidance${complete ? ' complete' : ''}`} aria-label={t('Training guidance')}>
    <div className="training-guidance-copy" role="status" aria-live="polite" aria-atomic="true">
      <div className="training-progress-label">
        {complete ? <CheckCircle2 size={17} aria-hidden="true" /> : <GraduationCap size={17} aria-hidden="true" />}
        <span>{t(complete ? 'Lesson complete' : 'Training mission')}</span>
        {!complete && <small>{t('Step {step} of {total}', { step: training.step, total: training.totalSteps })}</small>}
      </div>
      <h2>{t(training.title)}</h2><p>{t(training.instruction)}</p>
    </div>
    <div className="training-guidance-actions">
      {complete && training.nextLessonId && <button type="button" className="training-next" disabled={busy}
        onClick={() => onNext(training.nextLessonId!)}>{t('Next lesson')}<ArrowRight size={15} aria-hidden="true" /></button>}
      <button type="button" className="training-exit" disabled={busy} onClick={onExit}>
        {t(complete ? 'Back to Command' : 'Leave lesson')}
      </button>
    </div>
  </section>;
}
