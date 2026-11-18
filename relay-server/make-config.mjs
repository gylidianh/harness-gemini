// Generates both halves of a pairing, so nobody has to invent a secret by hand.
//
//   node relay-server/make-config.mjs
//
// Prints the desktop config to paste into <userData>/data/relay-config.json and the two
// environment values the relay needs. The pairing secret is shown once; it is what the phone
// types in, and the relay only ever receives its SHA-256.

import { createHash } from 'node:crypto';
import { randomSecret } from '../src152/shared/relay-protocol.mjs';
import { createVapidKeyPair } from './push.mjs';

const pairSecret = randomSecret(32);
const relayToken = randomSecret(32);
const pairCodeHash = createHash('sha256').update(pairSecret, 'utf8').digest('hex');

console.log('--- 1) 电脑端：<用户数据目录>/data/relay-config.json ---');
console.log(JSON.stringify({
  enabled: true,
  url: 'https://relay.example.com',
  relayToken,
  pairSecret,
  dispatchEnabled: false,
  devices: [],
}, null, 2));

console.log('\n--- 2) VPS：环境变量 ---');
// Existing subscriptions are bound to this pair: printing a new one on every run would be
// fine here, but copying an old pair forward keeps working phones working.
const vapid = createVapidKeyPair();
console.log(`RELAY_TOKEN=${relayToken}`);
console.log(`PAIR_CODE_HASH=${pairCodeHash}`);
console.log(`VAPID_PUBLIC_KEY=${vapid.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapid.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');

console.log('\n--- 3) 手机端配对码（一次性展示，别贴到公开地方）---');
console.log(pairSecret);

console.log('\n注：改 dispatchEnabled 为 true 并且把桌面的权限模式从「完整访问」切到「询问」或「智能」，');
console.log('    手机才能派发任务；这两个条件缺一个，远程派发都会被拒绝。');

console.log('\n注：VAPID 两个值必须长期保存，换了以后已开启通知的手机要重新点一次「开启通知」。');
console.log('    手机通知只在 HTTPS 下可用；iOS 还需要把页面「添加到主屏幕」且系统 16.4 以上。');
