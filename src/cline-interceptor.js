// Real Cline ask_followup_question -> Jev percentages.
// Input: Cline XML (old <follow_up><suggest> + new <options>) or JSON.
// Output: same options with " (XX%)" appended, ready to render in Cline UI.
import { scoreOptions } from './jev-client.js';

export function parseClineAsk(xml) {
  const q = (xml.match(/<question>([\s\S]*?)<\/question>/) || [])[1]?.trim() ?? '';
  const suggests = [...xml.matchAll(/<suggest>([\s\S]*?)<\/suggest>/g)].map((m) => m[1].trim());
  // new format: <options>["A","B"]</options> or <option>A</option>
  let options = suggests;
  if (!options.length) {
    const arr = (xml.match(/<options>([\s\S]*?)<\/options>/) || [])[1];
    if (arr) {
      try { options = JSON.parse(arr); }
      catch { options = [...arr.matchAll(/<option>([\s\S]*?)<\/option>/g)].map((m) => m[1].trim()); }
    }
  }
  return { question: q, options };
}

export function enrichXml(xml, probabilities) {
  // append " (XX%)" inside each <suggest> / <option>, keep XML valid for Cline
  return xml.replace(/<(suggest|option)>([\s\S]*?)<\/\1>/g, (m, tag, label) => {
    const clean = label.trim();
    const p = probabilities[clean];
    if (p == null) return m;
    if (clean.match(/\(\d+(\.\d+)?%\)\s*$/)) return m; // already enriched
    return `<${tag}>${clean} (${(p * 100).toFixed(1)}%)</${tag}>`;
  });
}

export async function interceptClineAsk({ xml, state, provider = 'zen-free' }) {
  const { question, options } = parseClineAsk(xml);
  if (!question || !options.length) throw new Error('No <question> + <suggest>/<options> found in Cline XML');
  const st = state || question; // Cline gives no separate state; question doubles as state, pass task context via --state for better scores
  const result = await scoreOptions({ state: st, question, options, provider });
  return { ...result, question, enrichedXml: enrichXml(xml, result.probabilities) };
}
