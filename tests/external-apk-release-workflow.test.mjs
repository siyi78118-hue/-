import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/publish-external-android-apk.yml', import.meta.url);
const workflowExists = existsSync(workflowUrl);
const workflow = workflowExists ? readFileSync(workflowUrl, 'utf8') : '';

function assertOrdered(...markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = workflow.indexOf(marker);
    assert.ok(index >= 0, `工作流缺少阶段：${marker}`);
    assert.ok(index > previous, `工作流阶段顺序错误：${marker}`);
    previous = index;
  }
}

test('外部 APK 发布工作流存在且只能手动触发', () => {
  assert.equal(workflowExists, true, '缺少外部 APK 重签发布工作流');
  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
});

test('工作流锁定未签名 1.0.87 的身份、原始哈希和正式证书', () => {
  assert.match(workflow, /EXPECTED_PACKAGE:\s*com\.siyi\.al/);
  assert.match(workflow, /EXPECTED_VERSION_CODE:\s*["']?87["']?/);
  assert.match(workflow, /EXPECTED_VERSION_NAME:\s*["']?1\.0\.87["']?/);
  assert.match(workflow, /F1BA04A68E0EC9FC330942E785201DDC929FCCED019F9F2D285402355A3D2D78/i);
  assert.match(workflow, /5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B/i);
  assert.doesNotMatch(workflow, /EXPECTED_SOURCE_SIGNER_SHA256/);
});

test('工作流在恢复正式密钥前验证 ZIP 并拒绝已签名源包', () => {
  assertOrdered(
    'name: Validate source APK',
    'name: Restore stable Android signing key'
  );
  assert.match(workflow, /unzip -tqq input\/source\.apk/);
  assert.match(workflow, /if "\$APKSIGNER" verify input\/source\.apk/);
  assert.match(workflow, /source APK must be unsigned/i);
});

test('工作流先验证原包，再恢复密钥、重签和验证正式证书', () => {
  assertOrdered(
    'name: Validate source APK',
    'name: Restore stable Android signing key',
    'name: Align and resign APK',
    'name: Validate resigned APK'
  );
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64:\s*\$\{\{\s*secrets\.ANDROID_KEYSTORE_BASE64\s*\}\}/);
  assert.match(workflow, /ZIPALIGN[\s\S]+APKSIGNER[\s\S]+sign/);
  assert.match(workflow, /EXPECTED_TARGET_SIGNER_SHA256/);
  const digestParsers = workflow.match(/sed -n 's\/\^\.\*certificate SHA-256 digest: \/\/p'/g) ?? [];
  assert.equal(digestParsers.length, 1, '正式证书应兼容新版 apksigner 输出前缀');
});

test('工作流明确启用 v3 签名并分别断言最终 APK 的 v2 与 v3 验签结果', () => {
  assert.match(workflow, /--v2-signing-enabled\s+true/);
  assert.match(workflow, /--v3-signing-enabled\s+true/);
  assert.match(
    workflow,
    /verify --verbose --print-certs output\/app-release\.apk[\s\S]+grep -F ["']Verified using v2 scheme \(APK Signature Scheme v2\): true["']/
  );
  assert.match(
    workflow,
    /verify --verbose --print-certs output\/app-release\.apk[\s\S]+grep -F ["']Verified using v3 scheme \(APK Signature Scheme v3\): true["']/
  );
});

test('工作流比较重签前后的 APK 内容且最后才更新清单', () => {
  assert.match(workflow, /zipfile\.ZipFile/);
  assert.match(workflow, /APK payload differs|APK entry list differs/);
  assert.doesNotMatch(workflow, /startswith\(["']META-INF\/["']\)/);
  assertOrdered(
    'name: Validate resigned APK',
    'name: Publish Android release',
    'name: Publish automatic update manifest',
    'name: Remove temporary source release'
  );
  assert.match(workflow, /"latestBuild": %s/);
  assert.match(workflow, /releases\/download\/android-v\$EXPECTED_VERSION_CODE\/app-release\.apk/);
});

test('工作流包含版本防回退门禁和发布串行锁', () => {
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /CURRENT_BUILD/);
  assert.match(workflow, /current update build.*not lower than requested build/i);
});

test('GitHub Release 附件故障时可从临时 Git 引用读取原包', () => {
  assert.match(workflow, /source_ref:/);
  assert.match(workflow, /SOURCE_REF:\s*\$\{\{\s*inputs\.source_ref\s*\}\}/);
  assert.match(workflow, /codex\/android-v87-source/);
  assert.match(workflow, /android-v87-source-20260723/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.source_ref\s*\}\}/);
  assert.match(workflow, /source-repo\/source\.apk/);
});

test('Release 上传失败时把正式签名 APK 发布到更新分支', () => {
  assert.match(workflow, /release_asset_published/);
  assert.match(workflow, /update-channel-repo\/app-release-v87\.apk/);
  assert.match(workflow, /app-release-v87\.apk/);
  assert.match(workflow, /raw\.githubusercontent\.com/);
  assertOrdered(
    'name: Validate resigned APK',
    'name: Publish Android release',
    'name: Publish signed APK fallback',
    'name: Publish automatic update manifest'
  );
});

test('首次创建 Release 时保留 app-release.apk 文件名供更新清单引用', () => {
  assert.match(workflow, /gh release create[\s\S]+\soutput\/app-release\.apk\s*$/m);
  assert.doesNotMatch(workflow, /output\/app-release\.apk#AL-/);
  assert.match(workflow, /ASSET_NAME[\s\S]+app-release\.apk/);
});

test('fallback 重跑时仅在暂存区有变化才提交，但始终继续推送和更新清单', () => {
  assert.match(
    workflow,
    /if ! git diff --cached --quiet; then[\s\S]+git commit -m ["']Publish AL Android \$EXPECTED_VERSION_NAME fallback APK["'][\s\S]+fi\s+git push origin HEAD:update-channel/
  );
  assertOrdered(
    'name: Publish signed APK fallback',
    'name: Publish automatic update manifest'
  );
});

test('发布成功后清理临时 source release 和 source ref', () => {
  assert.match(
    workflow,
    /name: Remove temporary source release\s+if: success\(\)/
  );
  assert.match(
    workflow,
    /gh release delete "\$SOURCE_TAG" --repo ['"]\$\{\{ github\.repository \}\}['"] --cleanup-tag --yes/
  );
  assert.match(
    workflow,
    /gh api --method DELETE "repos\/\$\{\{ github\.repository \}\}\/git\/refs\/heads\/\$SOURCE_REF"/
  );
  assert.doesNotMatch(workflow, /gh api --method DELETE[^\n]+\|\| true/);
  assert.doesNotMatch(workflow, /gh release delete "\$SOURCE_TAG"[^\n]+\|\| true/);
});
