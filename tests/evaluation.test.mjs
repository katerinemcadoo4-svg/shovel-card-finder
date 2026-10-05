import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { summarizeEvaluation } from '../scripts/evaluation_metrics.mjs';

function processResult(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: resolve('.'), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

test('metrics count only confident top-1 decisions and expose timing by category', () => {
  const rows = [
    { category: 'game', expectedHeroId: 'a', predictedHeroId: 'a', status: 'match', recognitionMs: 10, decodeMs: 2 },
    { category: 'game', expectedHeroId: 'b', predictedHeroId: null, status: 'uncertain', recognitionMs: 20, decodeMs: 3 },
    { category: 'splash', expectedHeroId: 'a', predictedHeroId: 'b', status: 'match', recognitionMs: 40, decodeMs: 4 },
    { category: 'unknown', status: 'match', recognitionMs: 15, decodeMs: 2 },
    { category: 'unknown', status: 'uncertain', recognitionMs: 25, decodeMs: 5 },
  ];
  const result = summarizeEvaluation(rows);
  assert.equal(result.game.top1Rate, 0.5);
  assert.equal(result.game.recognitionTime.medianMs, 10);
  assert.equal(result.splash.wrongDecisions, 1);
  assert.equal(result.unknown.falsePositiveRate, 0.5);
  assert.equal(result.unknown.recognitionTime.p95Ms, 25);
});

test('CLI smoke uses generated, non-independent images and marks report accordingly', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jcc-evaluation-smoke-'));
  try {
    const generated = await processResult('python', ['scripts/make_evaluation_smoke.py', root]);
    if (generated.code !== 0 && /No module named ['"]?PIL|Pillow is required/.test(generated.stderr)) {
      context.skip('Pillow is unavailable');
      return;
    }
    assert.equal(generated.code, 0, generated.stderr);
    const reportPath = join(root, 'report.json');
    const result = await processResult(process.execPath, ['scripts/evaluate.mjs',
      '--pack', 'tests/fixtures/generated/synthetic-test-pack.zip',
      '--manifest', join(root, 'cases.json'), '--output', reportPath,
      '--mode', 'js', '--allow-synthetic-smoke']);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.acceptanceEvidence, false);
    assert.equal(report.dataset.kind, 'synthetic-smoke');
    assert.equal(report.pack.referenceCount, 4);
    assert.equal(report.summary.game.count, 1);
    assert.equal(report.summary.splash.count, 1);
    assert.equal(report.summary.unknown.count, 1);
    assert.ok(report.cases.every(row => Number.isFinite(row.recognitionMs)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
