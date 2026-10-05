import {
  clearAssetPack,
  getAssetPackState,
  getReferences,
  importAssetPack,
  loadCatalog,
} from './src/catalog.mjs';
import { recognizeImage } from './src/recognition.mjs';
import { applyOcrTieBreak, ocrBoxForTie, recognizeChineseText } from './src/ocr.mjs';

const $ = id => document.getElementById(id);
const state = {
  catalog: null,
  references: [],
  imageUrl: null,
  artUrls: new Map(),
  pack: null,
  busy: false,
  detectedBox: null,
  atlasCost: null,
};

const statLabels = {
  health: '生命值', hp: '生命值', attackDamage: '攻击力', ad: '攻击力',
  attackSpeed: '攻击速度', armor: '护甲', magicResist: '魔法抗性',
  mana: '法力值', range: '攻击距离', critChance: '暴击率',
};
const reasonLabels = {
  no_references: '还没有参考图。请先导入当前赛季素材包。',
  no_usable_references: '参考图无法用于识别。请重新导入清晰的素材包。',
  image_decode_failed: '这张图片无法读取。请换一张 PNG、JPEG、WebP 或 HEIC 图片。',
  insufficient_evidence: '证据不足。请尝试更清晰、角色图面积更大的图片。',
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

function status(message, kind = '') {
  $('scan-status').className = `inline-status ${kind}`.trim();
  $('scan-status-text').textContent = message;
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

function renderResult(result) {
  const section = $('result-section');
  const list = $('candidate-list');
  $('detail-panel').hidden = true;
  section.hidden = false;
  const isMatch = result.status === 'match';
  $('result-tag').textContent = isMatch ? '已匹配' : '未确定';
  $('result-tag').className = `result-tag${isMatch ? ' confident' : ''}`;
  $('result-note').textContent = isMatch
    ? result.reason === 'ocr_tiebreak'
      ? '图像候选接近，画面文字支持首位角色。请核对结果。'
      : '请核对候选角色；同角色的不同皮肤或未收录画面可能影响结果。'
    : reasonLabels[result.reason] || '证据不足，请尝试更清晰的角色图。';
  const rows = (result.matches || []).slice(0, 3).map((match, index) => {
    const hero = heroById(match.heroId);
    return hero ? makeHeroRow(hero, { rank: index + 1, onClick: () => renderDetail(hero, 'detail-panel') }) : null;
  }).filter(Boolean);
  replaceChildren(list, ...(rows.length ? rows : [node('div', 'empty-note', '没有可靠候选。试试较清晰的单个角色原画或游戏图。')]));
  state.detectedBox = isMatch ? result.matches?.[0]?.box || null : null;
  updateDetectedBox();
}

function updateDetectedBox() {
  const frame = $('scan-preview');
  const image = $('preview-image');
  const overlay = $('detected-box');
  const box = state.detectedBox;
  if (!box || !image.naturalWidth || !image.naturalHeight || !frame.clientWidth || !frame.clientHeight) {
    overlay.hidden = true;
    return;
  }
  const scale = Math.min(frame.clientWidth / image.naturalWidth, frame.clientHeight / image.naturalHeight);
  const offsetX = (frame.clientWidth - image.naturalWidth * scale) / 2;
  const offsetY = (frame.clientHeight - image.naturalHeight * scale) / 2;
  overlay.style.left = `${offsetX + box.x * scale}px`;
  overlay.style.top = `${offsetY + box.y * scale}px`;
  overlay.style.width = `${box.width * scale}px`;
  overlay.style.height = `${box.height * scale}px`;
  overlay.hidden = false;
}

async function refreshCatalog() {
  clearArtUrls();
  state.catalog = await loadCatalog();
  state.pack = await getAssetPackState();
  state.references = await getReferences(state.catalog);
  renderLibrary();
  renderAtlas();
  $('detail-panel').hidden = true;
  $('atlas-detail').hidden = true;
  $('result-section').hidden = true;
  if (state.references.length) status(`已准备 ${state.references.length} 张本地参考图。请选择一张角色图片。`, 'success');
  else if (state.pack?.installed && state.pack.catalog?.patch !== state.catalog?.patch) {
    status(`素材包属于旧版 ${state.pack.catalog?.patch}，请导入 ${state.catalog?.patch} 版本素材包。`, 'error');
  } else status('先导入包含当前赛季角色与参考图的素材包，即可开始识别。');
}

async function onImageSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (state.busy) {
    status('正在识别上一张图片，请稍候。', 'busy');
    event.target.value = '';
    return;
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'].includes(file.type) ||
      file.size > 25 * 1024 * 1024) {
    status('请选择不超过 25 MB 的 PNG、JPEG、WebP 或 HEIC 图片。', 'error');
    event.target.value = '';
    return;
  }
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(file);
  $('preview-image').src = state.imageUrl;
  $('scan-preview').hidden = false;
  $('scan-art').hidden = true;
  $('result-section').hidden = true;
  $('detail-panel').hidden = true;
  state.detectedBox = null;
  updateDetectedBox();
  if (!state.references.length) {
    status('尚无可用参考图。请到“资料”导入当前赛季素材包。', 'error');
    event.target.value = '';
    return;
  }
  state.busy = true;
  status('正在本机分析图片…', 'busy');
  const startedAt = performance.now();
  try {
    let result = await recognizeImage(file, state.references, {
      onProgress({ phase, done, total }) {
        if (phase === 'references' && (done === total || done % 8 === 0)) {
          status(`正在准备本地参考图 ${done}/${total}…`, 'busy');
        } else if (phase === 'coarse') {
          status(`正在定位画面 ${done}/${total}…`, 'busy');
        } else if (phase === 'orb' && (done === total || done % 4 === 0)) {
          status(`正在核对图像特征 ${done}/${total}…`, 'busy');
        }
      },
    });
    const ocrBox = ocrBoxForTie(result);
    if (ocrBox) {
      status('图像候选接近，正在本机读取画面文字…', 'busy');
      const ocr = await recognizeChineseText(file, { box: ocrBox, timeoutMs: 12000 });
      result = applyOcrTieBreak(result, state.catalog?.heroes || [], ocr);
      result = { ...result, diagnostics: {
        ...result.diagnostics,
        ocrStatus: ocr.status,
        ocrMs: ocr.elapsedMs,
        ocrConfidence: ocr.confidence,
      } };
    }
    if (result.diagnostics) console.info(`Recognition diagnostics ${JSON.stringify(result.diagnostics)}`);
    renderResult(result);
    const elapsed = Math.round(performance.now() - startedAt);
    const timing = Number.isFinite(elapsed) ? `（${(elapsed / 1000).toFixed(1)} 秒）` : '';
    status(result.status === 'match' ? `识别完成${timing}。请核对结果。` : `识别完成${timing}，但暂不能确定角色。`, result.status === 'match' ? 'success' : '');
  } catch (error) {
    console.error('Recognition failed', error);
    status(`识别失败：${error.message || '请换一张图片重试。'}`, 'error');
  } finally {
    state.busy = false;
    event.target.value = '';
  }
}

async function onPackSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (state.busy) {
    $('pack-status').textContent = '正在识别图片，请完成后再导入素材包。';
    event.target.value = '';
    return;
  }
  state.busy = true;
  $('pack-status').textContent = '正在验证并导入素材包…';
  try {
    await importAssetPack(file, { catalog: state.catalog });
    await refreshCatalog();
    $('pack-status').textContent = `已导入：${file.name} · ${state.references.length} 张参考图`;
    navigate('atlas-view');
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
  $('image-input').addEventListener('change', onImageSelected);
  $('preview-image').addEventListener('load', updateDetectedBox);
  window.addEventListener('resize', updateDetectedBox);
  $('pack-input').addEventListener('change', onPackSelected);
  $('clear-pack').addEventListener('click', async () => {
    if (state.busy) {
      $('pack-status').textContent = '正在识别图片，请完成后再移除素材包。';
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
    status('资料读取失败。请检查网络或重新导入素材包。', 'error');
    $('atlas-meta').textContent = '资料读取失败';
  }
  await registerUpdates();
}

init();
