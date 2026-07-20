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

test('工作流锁定 1.0.74 的身份、原始哈希和签名证书', () => {
  assert.match(workflow, /EXPECTED_PACKAGE:\s*com\.siyi\.al/);
  assert.match(workflow, /EXPECTED_VERSION_CODE:\s*["']?74["']?/);
  assert.match(workflow, /EXPECTED_VERSION_NAME:\s*["']?1\.0\.74["']?/);
  assert.match(workflow, /358FC28355725B4DDE625E8BEC5122A1D0042F7DEE360E02AF0426141CA15425/i);
  assert.match(workflow, /383A167EB6C9264500C44C77F701C8176E15F997B726F7DD945350439B0A1A29/i);
  assert.match(workflow, /5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B/i);
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
});

test('工作流比较重签前后的 APK 内容且最后才更新清单', () => {
  assert.match(workflow, /zipfile\.ZipFile/);
  assert.match(workflow, /APK payload differs|APK entry list differs/);
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
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.source_ref\s*\}\}/);
  assert.match(workflow, /source-repo\/source\.apk/);
});

test('Release 上传失败时把正式签名 APK 发布到更新分支', () => {
  assert.match(workflow, /release_asset_published/);
  assert.match(workflow, /update-channel-repo\/app-release-v74\.apk/);
  assert.match(workflow, /raw\.githubusercontent\.com/);
  assertOrdered(
    'name: Validate resigned APK',
    'name: Publish Android release',
    'name: Publish signed APK fallback',
    'name: Publish automatic update manifest'
  );
});
