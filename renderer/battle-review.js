'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const stars = score => {
    const filled = Math.max(0, Math.min(5, Math.round(score)));
    return '★'.repeat(filled) + '☆'.repeat(5 - filled);
  };
  const pageSize = 24;
  let report;
  let side = 'p1';
  let file = null;
  let noteId = null;
  let selection = 0;
  let rows = [];
  let working = false;

  function showSource(open) {
    $('source-panel').hidden = !open;
    $('report').hidden = open || !report;
    $('review-another').hidden = open || !report;
    $('watch-review-source').hidden = open || !noteId;
    $('return-review').hidden = !report;
    $('analysis-status').textContent = '';
    if (open) {
      const isFile = document.querySelector('[name="source"]:checked').value === 'file';
      $(isFile ? 'choose-file' : 'review-url').focus();
    }
  }

  function disclosure(title, body) {
    const element = node('details', undefined, 'analysis-disclosure');
    element.append(node('summary', title), body);
    return element;
  }

  function table(caption, columns, records) {
    const element = node('table', undefined, 'analysis-table');
    element.append(node('caption', caption));
    const head = element.createTHead().insertRow();
    for (const text of columns) {
      const cell = node('th', text);
      cell.scope = 'col';
      head.append(cell);
    }
    const body = element.createTBody();
    for (const fields of records) {
      const row = body.insertRow();
      for (const [i, value] of fields.entries()) {
        const cell = node(i === 0 ? 'th' : 'td', value);
        if (i === 0) cell.scope = 'row';
        row.append(cell);
      }
    }
    return element;
  }

  function requestDetail(menu) {
    const section = node('section', undefined, 'analysis-request');
    section.append(node('h4', menu.kind + ' · ' + menu.played));
    const inventory = node('dl', undefined, 'analysis-evidence');
    for (const [label, value] of [
      ['Moves', menu.moves.join(', ')], ['Terastallization', menu.tera], ['Bench options', menu.switches.join(', ')],
      ['Availability', menu.uncertain ? 'The request flagged a possible hidden restriction.' : ''],
    ]) {
      if (value) inventory.append(node('dt', label), node('dd', value));
    }
    section.append(disclosure('Menu at the decision', inventory));
    const matchup = menu.matchup;
    if (matchup) {
      const frame = node('div');
      const caption = 'If ' + matchup.opponent + ' repeats ' + matchup.move + ' as a ' + matchup.type + '-type attack';
      frame.append(table(caption, ['Position', 'Typing', 'Chart factor', 'Selected modifiers to check'],
        matchup.defenders.map(item => [item.action, item.types, item.factor + '×', item.modifiers || '—'])),
        node('p', 'The move was shown on turn ' + matchup.turn + '. These chart factors use the typing at the request or on the proposed switch or Tera. A move can change typing. Damage and switch-in safety also depend on abilities, items, field effects, HP and the opponent’s actual choice.'));
      section.append(disclosure('Type matchups against ' + matchup.move, frame));
    }
    const tactics = menu.tactics;
    if (!tactics) {
      section.append(node('p', menu.reason, 'analysis-skip'));
      return section;
    }
    section.append(node('p', tactics.label, 'analysis-tactic-label'), node('p', tactics.summary),
      node('p', 'One turn of HP exchange · ' + tactics.worlds + ' hypothetical opposing teams · ' +
        tactics.seedsPerReply + ' check rolls per reply', 'analysis-skip'));
    const actionRows = tactics.candidates.map(action => [action.name + (action.played ? ' (played)' : ''),
      action.score.toFixed(1), action.foeHP.toFixed(1), action.ownHP.toFixed(1), action.foeKO.toFixed(2), action.ownKO.toFixed(2)]);
    const metrics = table('Scenario means at the end of the turn', ['Action', 'Net HP¹', 'Foe HP lost', 'Your HP lost', 'Foe faints', 'Your faints'], actionRows);
    const measures = node('div');
    measures.append(metrics, node('p', '¹ Net HP is opposing team HP lost minus your team HP lost. 100 points equals one full health bar. Negative HP lost means healing. The means cover ' + tactics.seedsPerReply + ' chance rolls per reply on each of ' + tactics.worlds + ' example teams. Rare outcomes can be missed.'));
    section.append(disclosure('Compare ' + actionRows.length + ' actions', measures));
    const replies = tactics.replies.map(r => [r.worldLabel ? r.worldLabel + ' · ' + r.reply : 'Set ' + r.world + ' · ' + r.reply,
      r.playedScore.toFixed(1), r.alternativeScore.toFixed(1)]);
    section.append(disclosure('Compare opponent replies', table('HP exchange by opposing set and reply',
      ['Opponent scenario', tactics.played, tactics.alternative], replies)));
    const assumptions = node('ul');
    for (const fact of [tactics.objective, ...tactics.assumptions]) assumptions.append(node('li', fact));
    section.append(disclosure('Simulation assumptions', assumptions));
    return section;
  }

  function detail(row) {
    const panel = $('turn-detail');
    panel.replaceChildren();
    if (!row) {
      panel.append(node('p', $('turn-filter').value === 'rated' ? 'No attacks met the comparison criteria.' : 'No turns match this filter.', 'analysis-no-turns'));
      return;
    }
    const heading = node('header', undefined, 'analysis-decision-head');
    heading.append(node('span', 'Turn ' + row.turn, 'analysis-turn-number'), node('h4', row.action));
    const label = node('p', row.requests?.length ? 'Player menu recorded' : row.label, 'analysis-verdict');
    if (Number.isFinite(row.stars) && !row.requests?.length) {
      const rating = node('span', stars(row.stars), 'analysis-row-stars');
      rating.setAttribute('aria-label', row.stars + ' out of 5 stars');
      label.append(' ', rating);
    }
    heading.append(label);
    panel.append(heading);
    for (const menu of row.requests || []) panel.append(requestDetail(menu));
    const evidence = node('dl', undefined, 'analysis-evidence');
    for (const [title, value] of [['Before the choice', row.before], ['What happened', row.outcome],
      ['Chance', row.luck], ['What to consider', row.requests?.length && row.comparison ? '' : row.lesson]]) {
      if (value) evidence.append(node('dt', title), node('dd', value));
    }
    panel.append(evidence);
  }

  function select(index, focus = false) {
    selection = index;
    const list = $('turn-list');
    list.replaceChildren();
    const start = Math.floor(selection / pageSize) * pageSize;
    for (let i = start; i < Math.min(start + pageSize, rows.length); i++) {
      const row = rows[i];
      const button = node('button', undefined, 'analysis-turn');
      button.type = 'button';
      button.append(node('span', String(row.turn), 'analysis-index'), node('span', row.action, 'analysis-action'));
      if (row.requests?.some(menu => menu.tactics)) {
        button.append(node('span', 'Simulated', 'analysis-mini-score'));
      } else if (row.stars != null && !row.requests?.length) {
        const rated = node('span', row.stars + ' ★', 'analysis-mini-score');
        rated.setAttribute('aria-label', row.stars + ' out of 5 stars');
        button.append(rated);
      }
      if (i === selection) button.setAttribute('aria-current', 'true');
      button.tabIndex = i === selection ? 0 : -1;
      button.addEventListener('click', () => select(i, true));
      list.append(button);
    }
    if (rows.length > pageSize) {
      const pages = node('div', undefined, 'analysis-list-pages');
      const prev = node('button', 'Previous', 'btn btn-quiet');
      const next = node('button', 'Next', 'btn btn-quiet');
      prev.type = next.type = 'button';
      prev.disabled = start === 0;
      next.disabled = start + pageSize >= rows.length;
      prev.addEventListener('click', () => select(start - pageSize, true));
      next.addEventListener('click', () => select(start + pageSize, true));
      pages.append(prev, node('span', (start + 1) + '–' + Math.min(start + pageSize, rows.length)), next);
      list.append(pages);
    }
    detail(rows[selection]);
    if (focus) list.querySelector('[aria-current]')?.focus({ preventScroll: true });
    if (focus) list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    else list.scrollTop = 0;
  }

  $('turn-list').addEventListener('keydown', event => {
    if (!event.target.matches('.analysis-turn')) return;
    const target = { ArrowDown: selection + 1, ArrowUp: selection - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(Math.max(0, Math.min(rows.length - 1, target)), true);
  });
  function filterRows(turn) {
    const filter = $('turn-filter').value;
    rows = report.sides[side].turns.filter(row => filter === 'all' ||
      (filter === 'rated' && row.stars != null && !row.requests?.length) ||
      (filter === 'tactics' && row.requests?.some(menu => menu.tactics)) ||
      (filter === 'menus' && row.requests?.length) || (filter === 'luck' && row.luck));
    select(turn === undefined ? 0 : Math.max(0, rows.findIndex(row => row.turn === turn)), turn !== undefined);
  }

  function renderSide() {
    const review = report.sides[side];
    const practice = review.practice;
    $('coverage-title').textContent = practice ? 'Practice decisions' : 'Overall play rating';
    $('game-score').textContent = practice ? practice.compared + ' simulated' : 'Unavailable';
    $('tactics-filter').hidden = $('menus-filter').hidden = !practice;
    $('coverage').textContent = practice
      ? practice.captured + ' confirmed choices recorded. Simulation covers eligible choices on turns 1–4.' +
        (practice.matchups ? ' ' + practice.matchups + ' choices have defensive type matchups.' : '') +
        (practice.unconfirmed ? ' ' + practice.unconfirmed + ' unconfirmed requests omitted.' : '') +
        (practice.truncated ? ' The capture reached its limit.' : '') : review.rated
      ? review.rated + ' of ' + review.decisions + ' visible choices compared. Four stars on ' +
        review.fourStars + ', two stars on ' + review.twoStars + '.'
      : report.supported ? 'No supported move comparisons for this player. ' + review.decisions + ' visible choices.' : 'Outside comparison scope';
    $('game-summary').textContent = review.summary;
    const simulated = review.turns.flatMap(row => (row.requests || []).filter(menu => menu.tactics)
      .map(menu => ({ turn: row.turn, ...menu.tactics })));
    const example = simulated.find(item => item.label === 'Opportunity to study') ||
      simulated.find(item => item.label === 'Prediction-dependent') || simulated[0];
    const revisit = example || review.turns.find(row => row.stars != null && row.stars <= 2 && !row.requests?.length);
    $('review-takeaway').hidden = !revisit;
    if (revisit) {
      const link = node('button', 'Revisit turn ' + revisit.turn, 'analysis-inline-link');
      link.type = 'button';
      link.addEventListener('click', () => { $('turn-filter').value = 'all'; filterRows(revisit.turn); });
      $('review-takeaway').replaceChildren(link, ' ' + (example ? example.summary : revisit.lesson));
    }
    $('method-title').textContent = practice ? 'How choices are compared' : 'How stars work';
    $('scoring-method').textContent = practice
      ? 'On turns 1–4, the simulator looks for two example teams that reproduce your menu and the preceding events. It compares one turn of HP changes and faints across the same replies and chance rolls. Later choices can show defensive type matchups against a previously seen attack. Overall strategic play is ungraded.'
      : report.scope.replace(/[.]$/, '') + (report.supported
      ? '. Four stars mark an open damage route against an immunity, or the higher base power of two otherwise matched attacks. Two mark the other side of either comparison. Rounding and knockouts can make both attacks deal the same damage. Both moves must be available and the target must stay as shown. The replay cannot establish which choice best served the whole game.' : '');
    $('turn-panel').hidden = !review.turns.length;
    const moments = $('moments');
    moments.replaceChildren();
    for (const highlight of review.highlights.slice(0, 3)) {
      const button = node('button', undefined, 'analysis-moment');
      button.type = 'button';
      button.append(node('strong', 'Turn ' + highlight.turn), node('span', highlight.text));
      button.addEventListener('click', () => {
        $('turn-filter').value = 'all';
        filterRows(highlight.turn);
      });
      moments.append(button);
    }
    $('highlights').hidden = !moments.childElementCount;
    $('turn-filter').value = 'all';
    filterRows();
  }

  async function loadReport(importing = false) {
    const result = await window.desktop.getBattleReview();
    if (!result?.ok) throw new Error('Could not load the battle review.');
    report = result.report;
    noteId = result.noteId;
    if (noteId) $('watch-review-source').href = 'replays.html?review=' + encodeURIComponent(noteId);
    else $('watch-review-source').removeAttribute('href');
    if (report) {
      side = result.side === 'p2' ? 'p2' : 'p1';
      const meta = [report.format, report.turnCount + (report.turnCount === 1 ? ' turn' : ' turns')];
      if (!report.supported) meta.push(report.winner ? report.winner + ' won' : 'Tie');
      $('match-meta').textContent = meta.join(' · ');
      $('matchup').textContent = report.players.p1 + ' vs. ' + report.players.p2;
      $('perspective').replaceChildren(...['p1', 'p2'].map(key => new Option(report.players[key], key)));
      $('perspective').value = side;
      renderSide();
    }
    showSource(importing || !report);
    if (report && !importing) $('matchup').focus({ preventScroll: true });
  }

  $('perspective').addEventListener('change', () => { side = $('perspective').value; renderSide(); });
  $('turn-filter').addEventListener('change', () => filterRows());
  $('review-another').addEventListener('click', () => showSource(true));
  $('return-review').addEventListener('click', () => { showSource(false); $('matchup').focus(); });
  const form = $('source-form');
  const submit = $('run-review');
  form.addEventListener('change', event => {
    if (event.target.name !== 'source') return;
    $('url-fields').hidden = event.target.value === 'file';
    $('file-fields').hidden = event.target.value === 'url';
    $('analysis-status').textContent = '';
  });
  $('choose-file').addEventListener('click', async () => {
    const button = $('choose-file');
    button.disabled = true;
    try {
      const chosen = await window.desktop.chooseBattleReviewFile();
      if (chosen?.ok && chosen.token) {
        file = chosen.token;
        $('file-name').textContent = chosen.name;
        $('analysis-status').textContent = '';
      } else if (!chosen?.cancelled) $('analysis-status').textContent = chosen?.error || 'Could not choose this file.';
    } catch { $('analysis-status').textContent = 'Could not open the file picker.'; }
    finally { button.disabled = false; }
  });
  $('cancel-review').addEventListener('click', async () => {
    try { await window.desktop.cancelBattleReview(); } catch { $('analysis-status').textContent = 'Could not cancel the review.'; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (working) return;
    const local = form.elements.source.value === 'file';
    const url = $('review-url').value.trim();
    if (local ? !file : !url) {
      $('analysis-status').textContent = local ? 'Choose a Showdown replay file first.' : 'Paste a Pokémon Showdown replay link first.';
      $(local ? 'choose-file' : 'review-url').focus();
      return;
    }
    working = true;
    const fields = form.querySelectorAll('input, #choose-file, #return-review');
    fields.forEach(field => { field.disabled = true; });
    $('cancel-review').hidden = false;
    try {
      await window.requestBattleReview(submit, local ? { kind: 'file', token: file } : { kind: 'url', url },
        $('analysis-status'), async () => {
          await loadReport();
          file = null;
          $('file-name').textContent = 'No file selected';
          $('review-url').value = '';
          history.replaceState(null, '', 'battle-review.html');
        });
    } finally {
      working = false;
      fields.forEach(field => { field.disabled = false; });
      $('cancel-review').hidden = true;
    }
  });
  loadReport(new URLSearchParams(location.search).has('import')).catch(() => {
    showSource(true);
    $('analysis-status').textContent = 'Could not load the previous review. You can import a replay here.';
  });
})();
