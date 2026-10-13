import { BookOpen } from 'lucide-react';
import type { Card } from '../types';
import { t } from '../i18n';
import './card-rules-help.css';

const KEYWORD_HELP = [
  ['Ambush', 'When played or deployed, this unit may immediately attack, even while exhausted. Ambush does not ready it. Normally, choose an enemy unit in the same arena; a base is not a legal target unless a card explicitly allows it. Without a legal target, there is no Ambush attack.'],
  ['Sentinel', 'Enemy units in this arena must attack a unit with Sentinel before attacking your other units or base. Saboteur can bypass Sentinel.'],
  ['Overwhelm', "When this unit attacks an enemy unit, excess combat damage is dealt to the defending player's base."],
  ['Restore', 'When this unit attacks, heal damage from your base equal to its Restore value.'],
  ['Raid', 'This unit gets extra power equal to its Raid value while attacking. Raid does not increase its power while defending.'],
  ['Saboteur', 'This unit ignores Sentinel when choosing an attack target. When it attacks a unit, defeat all Shield tokens on that defender before combat damage.'],
  ['Shielded', 'When played or deployed, this unit receives a Shield token. A Shield prevents the next instance of damage to the unit and is then defeated.'],
] as const;

interface CardRulesHelpProps {
  /** Actual keywords of the displayed live face; omitted for printed/alternate faces. */
  keywords?: Card['keywords'];
  /** Only the displayed face's text, never a fallback from the opposite face. */
  text: string;
  leader: boolean;
}

export function CardRulesHelp({ keywords, text, leader }: CardRulesHelpProps) {
  const actualKeywords = keywords?.map(keyword => (typeof keyword === 'string' ? keyword : keyword.name).trim().toLowerCase().replace(/\s+\d+.*$/, ''));
  const printedText = text.replace(/\\n/g, '\n');
  const entries = KEYWORD_HELP.filter(([name]) => actualKeywords
    ? actualKeywords.includes(name.toLowerCase())
    // A keyword mentioned inside another ability is not a keyword this face has.
    : new RegExp(`(?:^|\\n)\\s*${name}(?:\\s+\\d+)?[ \\t]*(?:\\(|[.,\\r\\n]|$)`, 'i').test(printedText));

  if (!leader && !entries.length) return null;

  return <details className="ci-rules-help">
    <summary><BookOpen size={15} aria-hidden="true" /><span>{t('Rules help')}</span></summary>
    <div className="ci-rules-help-content">
      <p>{t('These are general rules. Card text and current effects can change how they apply.')}</p>
      <dl>
        {entries.map(([name, explanation]) => <div key={name}><dt>{t(name)}</dt><dd>{t(explanation)}</dd></div>)}
        {leader && <div><dt>{t('Deploying a leader')}</dt><dd>{t('To deploy, you need at least the printed number of total resources, including exhausted ones. Deploying does not spend them. The epic deploy action can be used only once per game.')}</dd></div>}
      </dl>
    </div>
  </details>;
}
