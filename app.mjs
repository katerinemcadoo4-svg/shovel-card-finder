import {
  clearAssetPack,
  getAssetPackState,
  getReferences,
  importAssetPack,
  loadCatalog,
} from './src/catalog.mjs';
import { createQuiz, scoreQuiz } from './src/quiz.mjs';
import { loadLineups } from './src/lineups.mjs';

const $ = id => document.getElementById(id);
const state = {
  catalog: null,
  references: [],
  artUrls: new Map(),
  pack: null,
  busy: false,
  atlasCost: null,
  lineupCatalog: null,
  lineupStatus: 'loading',
  lineupQuality: 'S',
  quizPhase: 'ready',
  quizQuestions: [],
  quizAnswers: [],
  quizIndex: 0,
  quizAnswer: null,
  quizImageUrl: null,
  quizImageReady: false,
};

const statLabels = {
  health: '生命值', hp: '生命值', attackDamage: '攻击力', ad: '攻击力',
  attackSpeed: '攻击速度', armor: '护甲', magicResist: '魔法抗性',
  mana: '法力值', range: '攻击距离', critChance: '暴击率',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function replaceChildren(element, ...children) {
  element.replaceChildren(...children);
  return element;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function navigate(viewId) {
  for (const view of document.querySelectorAll('.view')) {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle('view-active', active);
  }
  for (const button of document.querySelectorAll('.nav-item')) {
    const active = button.dataset.view === viewId;
    button.classList.toggle('nav-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function heroById(id) {
  return state.catalog?.heroes?.find(hero => hero.id === id);
}

function imageUrlFor(heroId) {
  if (state.artUrls.has(heroId)) return state.artUrls.get(heroId);
  const reference = state.references.find(item => item.heroId === heroId);
  if (!reference?.blob) return null;
  const url = URL.createObjectURL(reference.blob);
  state.artUrls.set(heroId, url);
  return url;
}

function clearArtUrls() {
  for (const url of state.artUrls.values()) URL.revokeObjectURL(url);
  state.artUrls.clear();
}

function thumb(hero, className = 'hero-thumb') {
  const wrapper = node('span', className);
  const url = imageUrlFor(hero.id);
  if (url) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    wrapper.append(image);
  } else {
    wrapper.textContent = '✦';
    wrapper.setAttribute('aria-hidden', 'true');
  }
  return wrapper;
}

function makeHeroRow(hero, { rank = null, onClick }) {
  const row = node('button', rank === null ? 'hero-row' : 'candidate');
  row.type = 'button';
  row.append(thumb(hero));
  const body = node('span', rank === null ? 'hero-row-body' : 'candidate-body');
  body.append(node('span', rank === null ? 'hero-row-name' : 'candidate-name', hero.name));
  body.append(node('span', rank === null ? 'hero-row-meta' : 'candidate-meta',
    `${hero.cost ?? '—'} 费 · ${(hero.traits || []).join(' / ') || '羁绊待补充'}`));
  row.append(body);
  row.append(node('span', rank === null ? 'hero-cost' : 'candidate-rank', rank === null ? `${hero.cost ?? '—'} 费` : `候选 ${rank}`));
  row.addEventListener('click', onClick);
  return row;
}

function detailBlock(title, body) {
  const block = node('section', 'detail-block');
  block.append(node('h3', '', title), body);
  return block;
}

function textOrPlaceholder(text, placeholder = '当前资料包未提供。') {
  return node('p', '', text || placeholder);
}

function renderDetail(hero, targetId) {
  const target = $(targetId);
  const top = node('div', 'detail-top');
  top.append(thumb(hero, 'detail-portrait'));
  const identity = node('div', 'detail-identity');
  identity.append(node('p', 'eyebrow', `${hero.cost ?? '—'} 费角色`));
  const title = node('h2', 'detail-title', hero.name);
  title.id = targetId === 'atlas-detail' ? 'atlas-detail-title' : 'detail-title';
  identity.append(title);
  const traits = node('div', 'detail-traits');
  for (const trait of hero.traits || []) traits.append(node('span', 'trait', trait));
  identity.append(traits);
  top.append(identity);

  const skill = hero.skill || {};
  const skillText = skill.name ? `${skill.name} · ${skill.description || '说明待补充'}` : skill.description;
  const blocks = [top, detailBlock('技能', textOrPlaceholder(skillText))];

  const stats = node('div', 'stat-list');
  for (const [key, value] of Object.entries(hero.stats || {})) {
    const pair = node('div');
    pair.append(node('span', '', statLabels[key] || key), node('strong', '', value));
    stats.append(pair);
  }
  blocks.push(detailBlock('基础属性', stats.childElementCount ? stats : textOrPlaceholder('')));

  const guide = hero.recommendations || {};
  const items = node('ul');
  for (const item of guide.items || []) {
    items.append(node('li', '', `${item.name}${item.reason ? ` · ${item.reason}` : ''}`));
  }
  blocks.push(detailBlock('推荐装备', items.childElementCount ? items : textOrPlaceholder('')));
  const comps = node('ul');
  for (const comp of guide.comps || []) {
    comps.append(node('li', '', `${comp.name}${comp.description ? ` · ${comp.description}` : ''}`));
  }
  blocks.push(detailBlock('阵容搭配', comps.childElementCount ? comps : textOrPlaceholder('')));

  const notes = node('p', '', `资料版本：${guide.patch || state.catalog?.patch || '未核验'}。攻略仅供当前标注版本参考。`);
  blocks.push(detailBlock('版本', notes));

  const sources = node('div', 'source-list');
  const wantedIds = new Set(['current-season', 'version', 'heroes', 'races', 'jobs', ...(guide.sourceIds || [])]);
  const sourceList = (state.catalog?.sources || []).filter(source => wantedIds.has(source.id));
  for (const source of sourceList) {
    const url = safeHttpUrl(source.url);
    if (!url) continue;
    const link = node('a', '', source.title || source.name || url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    sources.append(link);
  }
  blocks.push(detailBlock('资料出处', sources.childElementCount ? sources : textOrPlaceholder('')));
  replaceChildren(target, ...blocks);
  target.hidden = false;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAtlas() {
  const search = $('atlas-search').value.trim().toLowerCase();
  const heroes = state.catalog?.heroes || [];
  const filtered = heroes.filter(hero => {
    const haystack = [hero.name, ...(hero.traits || [])].join(' ').toLowerCase();
    return (state.atlasCost === null || hero.cost === state.atlasCost) && haystack.includes(search);
  });
  const costLabel = state.atlasCost === null ? '全部费用' : `${state.atlasCost} 费`;
  $('atlas-meta').textContent = heroes.length ? `${costLabel} · ${search ? '找到' : '共'} ${filtered.length} 名角色` : '尚无已核验的赛季角色资料';
  const list = $('hero-list');
  if (!filtered.length) {
    replaceChildren(list, node('div', 'empty-note', heroes.length ? `没有找到符合条件的${state.atlasCost === null ? '' : ` ${state.atlasCost} 费`}角色。` : '导入含当前赛季资料的素材包后，图鉴会显示在这里。'));
    return;
  }
  const groups = [];
  const costs = [...new Set(filtered.map(hero => hero.cost))].sort((a, b) => a - b);
  for (const cost of costs) {
    const members = filtered.filter(hero => hero.cost === cost);
    if (!members.length) continue;
    const group = node('section', 'cost-group');
    const heading = node('div', 'cost-group-heading');
    const title = node('h2', '', `${cost} 费角色`);
    title.id = `cost-group-${cost}`;
    group.setAttribute('aria-labelledby', title.id);
    heading.append(title, node('span', 'cost-group-count', `${members.length} 名`));
    const rows = node('div', 'hero-list');
    rows.append(...members.map(hero => makeHeroRow(hero, { onClick: () => renderDetail(hero, 'atlas-detail') })));
    group.append(heading, rows);
    groups.push(group);
  }
  replaceChildren(list, ...groups);
}

function renderLineups() {
  const data = state.lineupCatalog;
  const list = $('lineup-list');
  if (!data) {
    const loading = state.lineupStatus === 'loading';
    $('lineup-meta').textContent = loading ? '正在准备阵容资料…' : '阵容资料暂不可用';
    $('lineup-version').textContent = '';
    replaceChildren(list, node('p', 'empty-note', loading ? '正在读取官方阵容资料…' : '未能读取与当前赛季版本一致的阵容资料，请联网更新后重试。'));
    return;
  }
  const search = $('lineup-search').value.trim().toLowerCase();
  const filtered = data.lineups.filter(lineup => {
    const names = [lineup.name, ...lineup.members.flatMap(member => [member.name, ...(heroById(member.heroId)?.traits || [])])].join(' ').toLowerCase();
    return (state.lineupQuality === null || lineup.quality === state.lineupQuality) && names.includes(search);
  });
  $('lineup-version').textContent = `${data.seasonName} · ${data.patch} · 核验于 ${data.updatedAt}`;
  $('lineup-meta').textContent = `${state.lineupQuality ? `官方 ${state.lineupQuality} 级` : '全部推荐'} · ${filtered.length} 套阵容`;
  if (!filtered.length) {
    replaceChildren(list, node('p', 'empty-note', '没有找到符合条件的阵容，试试其他角色或羁绊。'));
    return;
  }
  replaceChildren(list, ...filtered.map((lineup, index) => {
    const card = node('details', 'lineup-card');
    card.open = index === 0;
    const summary = node('summary', 'lineup-summary');
    const title = node('span', 'lineup-title');
    title.append(node('span', 'lineup-grade', lineup.quality), node('strong', '', lineup.name));
    summary.append(title, node('span', 'lineup-summary-meta', `${lineup.members.length} 名成员 · ${data.patch}`));
    const body = node('div', 'lineup-body');
    body.append(node('h2', 'lineup-section-title', '阵容成员'));
    const members = node('div', 'lineup-members');
    for (const member of lineup.members) {
      const hero = heroById(member.heroId);
      const tile = node(hero ? 'button' : 'div', `lineup-member${member.isCarry ? ' lineup-carry' : ''}`);
      if (hero) {
        tile.type = 'button';
        tile.setAttribute('aria-label', `查看${member.name}的角色详情`);
        tile.append(thumb(hero, 'lineup-portrait'));
        tile.addEventListener('click', () => { navigate('atlas-view'); renderDetail(hero, 'atlas-detail'); });
      } else tile.append(node('span', 'lineup-portrait', '✦'));
      tile.append(node('span', 'lineup-member-name', member.name));
      const label = member.kind === 'pet' ? '召唤单位' : `${member.cost} 费${member.isCarry ? ' · 主 C' : ''}`;
      tile.append(node('span', 'lineup-member-meta', label));
      members.append(tile);
    }
    body.append(members);
    const builds = node('div', 'lineup-builds');
    for (const member of lineup.members.filter(member => member.items.length)) {
      const build = node('div', 'lineup-build');
      build.append(node('strong', '', member.name));
      const items = node('div', 'lineup-item-tags');
      for (const item of member.items) items.append(node('span', '', item.name));
      build.append(items);
      builds.append(build);
    }
    if (builds.childElementCount) body.append(node('h2', 'lineup-section-title', '推荐装备'), builds);
    const guide = node('details', 'lineup-guide');
    guide.append(node('summary', '', '查看运营与站位建议'));
    const guideLabels = { early: '前期过渡', reroll: '搜牌节奏', position: '站位建议', equipment: '装备分析', augments: '强化符文', matchups: '克制与应对', adventure: '奇遇建议' };
    for (const [key, label] of Object.entries(guideLabels)) {
      if (!lineup.guide[key]) continue;
      const section = node('section');
      section.append(node('h3', '', label), node('p', '', lineup.guide[key]));
      guide.append(section);
    }
    if (guide.childElementCount > 1) body.append(guide);
    const attribution = node('p', 'lineup-attribution', `${lineup.author ? `作者：${lineup.author} · ` : ''}官方阵容 #${lineup.officialId}`);
    body.append(attribution);
    const source = data.sources.find(source => source.id === 'lineups');
    const url = safeHttpUrl(source?.url);
    if (url) {
      const link = node('a', 'lineup-source', '查看官方资料出处 ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      body.append(link);
    }
    card.append(summary, body);
    return card;
  }));
}

function infoPair(label, value) {
  const row = node('div');
  row.append(node('span', '', label), node('strong', '', value));
  return row;
}

function renderLibrary() {
  const catalog = state.catalog;
  const info = $('catalog-info');
  const title = node('h2', '', '当前资料');
  const grid = node('div', 'info-kv');
  grid.append(
    infoPair('赛季', catalog?.seasonId || '未核验'),
    infoPair('游戏版本', catalog?.patch || '未核验'),
    infoPair('已收录角色', String(catalog?.heroes?.length || 0)),
    infoPair('本地参考图', String(state.references.length)),
    infoPair('资料日期', catalog?.updatedAt || '—'),
  );
  replaceChildren(info, title, grid);
  const hasPack = Boolean(state.pack?.installed);
  const packStale = hasPack && (state.pack.catalog?.seasonId !== catalog?.seasonId || state.pack.catalog?.patch !== catalog?.patch);
  $('pack-status').textContent = packStale
    ? `本地素材包适用于 ${state.pack.catalog?.patch || '旧版本'}，请导入当前版本素材包。`
    : hasPack
    ? `本地素材包已导入 · ${state.pack.referenceCount || 0} 张参考图`
    : '尚未导入本地素材包。';
  $('clear-pack').hidden = !hasPack;
  $('season-chip').textContent = catalog?.heroes?.length
    ? `${catalog.seasonName || catalog.seasonId} · ${catalog.patch}`
    : '资料待导入';
}

function clearQuizImage() {
  $('quiz-image').removeAttribute('src');
  if (state.quizImageUrl) URL.revokeObjectURL(state.quizImageUrl);
  state.quizImageUrl = null;
  state.quizImageReady = false;
}

function quizCorrectCount() {
  return state.quizAnswers.filter(answer => answer.correct).length;
}

function renderQuizStats() {
  const answered = state.quizAnswers.length;
  const correct = quizCorrectCount();
  $('quiz-win-rate').textContent = `${answered ? Math.round(correct / answered * 100) : 0}%`;
  $('quiz-win-count').textContent = `答对 ${correct} / 已答 ${answered} 题`;
  const last = state.quizAnswers.at(-1);
  $('quiz-last-answer').textContent = last
    ? last.correct ? '上一题答对，获得 5 分。' : '本题答错，记住正确答案再继续。'
    : '答题胜率 = 本套答对题数 ÷ 已答题数';
}

function renderQuizReady() {
  state.quizPhase = 'ready';
  state.quizQuestions = [];
  state.quizAnswers = [];
  state.quizIndex = 0;
  state.quizAnswer = null;
  renderQuizStats();
  clearQuizImage();
  $('quiz-ready').hidden = false;
  $('quiz-play').hidden = true;
  $('quiz-complete').hidden = true;
  $('quiz-review').hidden = true;
  const heroIds = new Set((state.catalog?.heroes || []).map(hero => hero.id));
  const count = new Set(state.references.filter(reference => heroIds.has(reference.heroId) && reference.blob?.size > 0).map(reference => reference.heroId)).size;
  const ready = count >= 2;
  $('start-quiz').disabled = !ready;
  $('quiz-import').hidden = ready;
  $('quiz-ready-note').textContent = ready
    ? `已准备 ${count} 名角色的图片。${count < 20 ? '本套会轮换已导入的角色。' : '每套随机抽取 20 名角色。'}`
    : '先到“资料”导入至少两名角色的图片，再开始练习。';
}

function startQuiz() {
  if (state.busy) return;
  const questions = createQuiz(state.catalog, state.references);
  if (!questions.length) {
    $('quiz-ready-note').textContent = '可用角色图片不足，请到“资料”导入完整素材包。';
    $('quiz-import').hidden = false;
    return;
  }
  state.quizQuestions = questions;
  state.quizAnswers = [];
  state.quizIndex = 0;
  state.quizPhase = 'playing';
  renderQuestion();
}

function renderQuestion() {
  clearQuizImage();
  state.quizAnswer = null;
  const question = state.quizQuestions[state.quizIndex];
  $('quiz-ready').hidden = true;
  $('quiz-complete').hidden = true;
  $('quiz-review').hidden = true;
  $('quiz-play').hidden = false;
  $('question-title').textContent = `第 ${state.quizIndex + 1} / 20 题`;
  $('quiz-live-score').textContent = `已得 ${scoreQuiz(quizCorrectCount()).score} 分`;
  $('quiz-progress').value = state.quizAnswers.length;
  renderQuizStats();
  $('quiz-feedback').hidden = true;
  $('quiz-feedback').textContent = '';
  $('next-question').hidden = true;
  $('quiz-image-error').hidden = true;
  $('quiz-image').hidden = false;
  $('quiz-image').alt = `第 ${state.quizIndex + 1} 题角色图片`;
  replaceChildren($('quiz-options'), ...question.options.map((option, i) => {
    const button = node('button', 'quiz-option');
    button.type = 'button';
    button.dataset.heroId = option.heroId;
    button.disabled = true;
    button.append(node('span', 'option-letter', String.fromCharCode(65 + i)), node('span', 'option-name', option.name), node('span', 'option-mark'));
    button.addEventListener('click', () => answerQuestion(option.heroId, question));
    return button;
  }));
  state.quizImageUrl = URL.createObjectURL(question.reference.blob);
  $('quiz-image').src = state.quizImageUrl;
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('question-title').focus({ preventScroll: true });
}

function answerQuestion(selectedHeroId, displayedQuestion) {
  if (state.quizPhase !== 'playing' || state.quizAnswer !== null || !state.quizImageReady) return;
  const question = state.quizQuestions[state.quizIndex];
  if (displayedQuestion !== question) return;
  const correct = selectedHeroId === question.heroId;
  state.quizAnswer = selectedHeroId;
  state.quizAnswers.push({ heroId: question.heroId, selectedHeroId, correct });
  renderQuizStats();
  if (correct) {
    advanceQuestion();
    return;
  }
  for (const button of $('quiz-options').children) {
    button.disabled = true;
    const mark = button.querySelector('.option-mark');
    if (button.dataset.heroId === question.heroId) {
      button.classList.add('is-correct');
      mark.textContent = '✓ 正确答案';
    } else if (button.dataset.heroId === selectedHeroId) {
      button.classList.add('is-wrong');
      mark.textContent = '✕ 你选的';
    }
  }
  const name = heroById(question.heroId)?.name || '该角色';
  $('quiz-feedback').className = 'quiz-feedback feedback-wrong';
  $('quiz-feedback').textContent = `答错了，正确答案是${name}。`;
  $('quiz-feedback').hidden = false;
  $('quiz-live-score').textContent = `已得 ${scoreQuiz(quizCorrectCount()).score} 分`;
  $('quiz-progress').value = state.quizAnswers.length;
  $('next-question').textContent = state.quizIndex === 19 ? '查看成绩' : '下一题';
  $('next-question').hidden = false;
  $('next-question').focus({ preventScroll: true });
  $('next-question').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function advanceQuestion() {
  if (state.quizAnswer === null || state.quizPhase !== 'playing') return;
  if (state.quizIndex === state.quizQuestions.length - 1) showQuizResult();
  else { state.quizIndex++; renderQuestion(); }
}

function showQuizResult() {
  clearQuizImage();
  state.quizPhase = 'complete';
  $('quiz-play').hidden = true;
  $('quiz-complete').hidden = false;
  const result = scoreQuiz(quizCorrectCount());
  $('quiz-final-score').textContent = result.score;
  $('quiz-score-summary').textContent = `答对 ${result.correctCount} / 20 题 · 答题胜率 ${result.correctCount * 5}% · 答错 ${20 - result.correctCount} 题`;
  const wrong = state.quizAnswers.filter(answer => !answer.correct);
  $('quiz-review').hidden = !wrong.length;
  replaceChildren($('quiz-wrong-list'), ...wrong.map(answer => {
    const hero = heroById(answer.heroId);
    const row = node('button', 'hero-row');
    row.type = 'button';
    const body = node('span', 'hero-row-body');
    body.append(node('span', 'hero-row-name', hero.name), node('span', 'hero-row-meta', `你选了：${heroById(answer.selectedHeroId)?.name || '其他角色'}`));
    row.append(thumb(hero), body, node('span', 'hero-cost', '正确答案'));
    row.addEventListener('click', () => { navigate('atlas-view'); renderDetail(hero, 'atlas-detail'); });
    return row;
  }));
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('quiz-complete-title').focus({ preventScroll: true });
}

async function refreshLineups(catalog) {
  state.lineupCatalog = null;
  state.lineupStatus = 'loading';
  renderLineups();
  try {
    const lineups = await loadLineups(catalog);
    if (state.catalog !== catalog) return;
    state.lineupCatalog = lineups;
    state.lineupStatus = 'ready';
  } catch (error) {
    if (state.catalog !== catalog) return;
    state.lineupStatus = 'failed';
    console.warn('Lineups unavailable', error);
  }
  renderLineups();
}

async function refreshCatalog() {
  clearArtUrls();
  state.catalog = await loadCatalog();
  state.pack = await getAssetPackState();
  state.references = await getReferences(state.catalog);
  renderLibrary();
  renderAtlas();
  $('atlas-detail').hidden = true;
  renderQuizReady();
  // The independent guide download must never delay quiz or asset-pack setup.
  void refreshLineups(state.catalog);
}

async function onPackSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (state.busy) {
    $('pack-status').textContent = '素材包正在处理，请稍候再导入。';
    event.target.value = '';
    return;
  }
  state.busy = true;
  $('pack-status').textContent = '正在验证并导入素材包…';
  try {
    await importAssetPack(file, { catalog: state.catalog });
    await refreshCatalog();
    $('pack-status').textContent = `已导入：${file.name} · ${state.references.length} 张参考图`;
    navigate('quiz-view');
  } catch (error) {
    console.error('Asset pack import failed', error);
    $('pack-status').textContent = `导入失败：${error.message || '素材包无效'}`;
  } finally {
    state.busy = false;
    event.target.value = '';
  }
}

async function registerUpdates() {
  try {
    const response = await fetch(new URL('./version.json', import.meta.url), { cache: 'no-store' });
    if (response.ok) {
      const version = await response.json();
      $('app-version').textContent = `应用版本 ${version.appVersion} · 内容版本 ${version.contentVersion}`;
    }
  } catch {
    $('app-version').textContent = '当前离线运行';
  }
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const ownScope = new URL('./', import.meta.url).href;
    await Promise.all(registrations.filter(registration => registration.scope === ownScope)
      .map(registration => registration.unregister()));
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './' });
    const showUpdate = () => { $('update-banner').hidden = false; };
    if (registration.waiting && navigator.serviceWorker.controller) showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
      });
    });
    $('apply-update').addEventListener('click', () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) { refreshing = true; window.location.reload(); }
    });
    if (navigator.onLine) registration.update().catch(() => {});
  } catch (error) {
    console.warn('Service worker unavailable', error);
  }
}

async function init() {
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  $('atlas-search').addEventListener('input', () => {
    $('atlas-detail').hidden = true;
    renderAtlas();
  });
  $('cost-filters').addEventListener('click', event => {
    const button = event.target.closest('button[data-cost]');
    if (!button) return;
    state.atlasCost = button.dataset.cost === 'all' ? null : Number(button.dataset.cost);
    $('cost-filters').querySelectorAll('button').forEach(filter => {
      filter.setAttribute('aria-pressed', String(filter === button));
    });
    $('atlas-detail').hidden = true;
    renderAtlas();
  });
  $('start-quiz').addEventListener('click', startQuiz);
  $('restart-quiz').addEventListener('click', startQuiz);
  $('quiz-import').addEventListener('click', () => navigate('library-view'));
  $('quiz-atlas').addEventListener('click', () => navigate('atlas-view'));
  $('quiz-lineups').addEventListener('click', () => navigate('lineups-view'));
  $('lineup-search').addEventListener('input', renderLineups);
  $('lineup-filters').addEventListener('click', event => {
    const button = event.target.closest('button[data-quality]');
    if (!button) return;
    state.lineupQuality = button.dataset.quality === 'all' ? null : button.dataset.quality;
    $('lineup-filters').querySelectorAll('button').forEach(filter => filter.setAttribute('aria-pressed', String(filter === button)));
    renderLineups();
  });
  $('next-question').addEventListener('click', advanceQuestion);
  $('quiz-image').addEventListener('load', () => {
    if (state.quizPhase !== 'playing' || !$('quiz-image').naturalWidth) return;
    state.quizImageReady = true;
    if (state.quizAnswer === null) for (const button of $('quiz-options').children) button.disabled = false;
  });
  $('quiz-image').addEventListener('error', () => {
    if (state.quizPhase !== 'playing') return;
    state.quizImageReady = false;
    $('quiz-image').hidden = true;
    $('quiz-image-error').hidden = false;
    for (const button of $('quiz-options').children) button.disabled = true;
  });
  $('pack-input').addEventListener('change', onPackSelected);
  $('clear-pack').addEventListener('click', async () => {
    if (state.busy) {
      $('pack-status').textContent = '素材包正在处理，请稍候再移除。';
      return;
    }
    state.busy = true;
    try {
      await clearAssetPack();
      await refreshCatalog();
    } catch (error) {
      console.error('Asset pack removal failed', error);
      $('pack-status').textContent = `移除失败：${error.message || '本地存储不可用'}`;
    } finally {
      state.busy = false;
    }
  });
  try {
    await refreshCatalog();
  } catch (error) {
    console.error('Catalog unavailable', error);
    $('quiz-ready-note').textContent = '资料读取失败。请检查网络或到“资料”重新导入素材包。';
    $('quiz-import').hidden = false;
    $('atlas-meta').textContent = '资料读取失败';
    state.lineupStatus = 'failed';
    renderLineups();
  }
  await registerUpdates();
}

init();
