import { useId } from 'react';
import { ArrowRight, ClipboardList, Crosshair, Lightbulb, Trophy } from 'lucide-react';
import { t } from '../i18n';
import './match-review.css';

export interface MatchReviewMoment {
  id: string;
  kind: 'base-option' | 'threat-option' | 'finishing-blow' | 'opponent-finishing-blow' | 'base-hit' | 'unit-defeated' | 'leader-deployed';
  round: number;
  card: string;
  target?: string;
  power?: number;
  health?: number;
  damage?: number;
}

export interface MatchReviewData {
  version: 1;
  outcome: 'win' | 'loss' | 'draw';
  winnerIds: string[];
  rounds: number;
  partial: boolean;
  stats: { decisions: number; plays: number; deploys: number; baseDamage: number; initiativeClaims: number };
  moments: MatchReviewMoment[];
}

function momentCopy(moment: MatchReviewMoment) {
  const variables = { card: moment.card, target: moment.target || '', power: moment.power ?? 0, health: moment.health ?? 0, damage: moment.damage ?? 0 };
  switch (moment.kind) {
    case 'base-option': return {
      title: t('Check the base before trading'),
      fact: t('At this choice, {card} showed {power} attacking power and the enemy base had {health} health. The base was a legal target; you selected {target}.', variables),
      lesson: t('Before trading units, compare the health of a legal base target with your attack. Effects during combat can change the result.'),
    };
    case 'threat-option': return {
      title: t('Watch ready enemy units'),
      fact: t('At this choice, {target} was ready with {power} attacking power while your base had {health} health. It was a legal target for {card}.', variables),
      lesson: t('Check ready enemy units before committing to another target. Whether they can attack your base depends on the board and card effects.'),
    };
    case 'finishing-blow': return {
      title: t('The finishing damage'),
      fact: t('{card} dealt {damage} damage to the enemy base in your final successful choice.', variables),
      lesson: t('The engine confirmed your win after this choice.'),
    };
    case 'opponent-finishing-blow': return {
      title: t('The final enemy hit'),
      fact: t('{card} dealt {damage} damage to your base before the game ended.', variables),
      lesson: t('When reviewing the previous round, look for ways to protect your base or finish the game sooner.'),
    };
    case 'base-hit': return {
      title: t('Pressure on the base'),
      fact: t('{card} dealt {damage} damage to the enemy base. It had {health} health after this choice.', variables),
      lesson: t('Base damage creates a shorter path to victory. Compare it with the value of removing an enemy unit.'),
    };
    case 'unit-defeated': return {
      title: t('A unit removed'),
      fact: t('The attack by {card} defeated {target}.', variables),
      lesson: t('Compare what the trade removed with the damage or units you gave up.'),
    };
    case 'leader-deployed': return {
      title: t('Your leader joined the battle'),
      fact: t('You deployed {card}.', variables),
      lesson: t('Plan the resource threshold and the board position for your once-per-game deploy action.'),
    };
  }
}

export function MatchReviewSummary({ review, onOpen }: { review: MatchReviewData; onOpen: () => void }) {
  return <button className="match-review-summary" onClick={onOpen}>
    <ClipboardList size={19} aria-hidden="true" />
    <span><strong>{t('Review this battle')}</strong><small>{t('{rounds} rounds · {damage} base damage', { rounds: review.rounds, damage: review.stats.baseDamage })}</small></span>
    <ArrowRight size={17} aria-hidden="true" />
  </button>;
}

/** The parent owns the accessible modal and its close/next-game controls. */
export function MatchReview({ review }: { review: MatchReviewData }) {
  const headingId = useId();
  const result = review.outcome === 'win' ? t('Victory') : review.outcome === 'loss' ? t('Defeat') : t('Draw');
  return <section className="match-review" aria-labelledby={headingId}>
    <header className={`match-review-header match-review-header-${review.outcome}`}>
      <Trophy size={25} aria-hidden="true" />
      <div><h2 id={headingId}>{result}</h2><p>{t('Battle finished in round {rounds}.', { rounds: review.rounds })}</p></div>
    </header>
    <dl className="match-review-stats">
      <div><dt>{t('Choices made')}</dt><dd>{review.stats.decisions}</dd></div>
      <div><dt>{t('Cards played')}</dt><dd>{review.stats.plays}</dd></div>
      <div><dt>{t('Leaders deployed')}</dt><dd>{review.stats.deploys}</dd></div>
      <div><dt>{t('Damage to enemy base')}</dt><dd>{review.stats.baseDamage}</dd></div>
    </dl>
    {review.partial && <p className="match-review-note">{t('This review covers choices recorded after the review feature became available in this saved game.')}</p>}
    <h3 className="match-review-section-title"><Crosshair size={16} aria-hidden="true" />{t('Key moments')}</h3>
    {review.moments.length ? <ol className="match-review-moments">
      {review.moments.map(moment => {
        const copy = momentCopy(moment);
        const learning = moment.kind === 'base-option' || moment.kind === 'threat-option';
        return <li key={moment.id} className={learning ? 'match-review-moment match-review-learning' : 'match-review-moment'}>
          <div className="match-review-moment-heading"><span>{t('Round {round}', { round: moment.round })}</span><h4>{copy.title}</h4></div>
          <p>{copy.fact}</p>
          <p className="match-review-lesson"><Lightbulb size={14} aria-hidden="true" /><span>{copy.lesson}</span></p>
        </li>;
      })}
    </ol> : <p className="match-review-note">{t('No major attack moments were recorded. Use the battle log to revisit your plays and resource choices.')}</p>}
    <p className="match-review-limits">{t('Based on legal choices and public board information. Tactical suggestions are observations, not a guarantee of a winning line.')}</p>
  </section>;
}
