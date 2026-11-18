/**
 * Harness Gemini UI - Web Audio Sound Synthesis & Completion Notifications
 * License: MIT
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMPLETION_MODE_LABELS = {
  chat: '聊天回复已完成',
  agent: '编程任务已完成',
  image: '图片生成已完成',
};

const DESKTOP_FAIL_REASONS = new Set([
  'unsupported',
  'suppressed',
  'unavailable',
  'failed',
  'throttled',
]);

let sharedAudioContext;
const pendingPermissionRequests = new WeakMap();

export function getNotificationCapability(env = globalThis) {
  const desktop = env.harnessDesktop?.completionNotifications === true;
  const NotificationCtor = env.Notification;
  return {
    desktop,
    permission: desktop
      ? 'granted'
      : typeof NotificationCtor === 'function'
        ? NotificationCtor.permission || 'default'
        : 'unsupported',
  };
}

export async function requestNotificationPermission(env = globalThis) {
  const capability = getNotificationCapability(env);
  if (capability.desktop || capability.permission !== 'default') {
    return capability.permission;
  }
  if (!pendingPermissionRequests.has(env)) {
    const request = Promise.resolve()
      .then(() => env.Notification.requestPermission())
      .catch(() => 'denied')
      .finally(() => pendingPermissionRequests.delete(env));
    pendingPermissionRequests.set(env, request);
  }
  return pendingPermissionRequests.get(env);
}

export async function sendTestCompletionNotification(env = globalThis) {
  if (getNotificationCapability(env).desktop) {
    if (typeof env.harnessDesktop.testCompletionNotification !== 'function') {
      return { sent: false, reason: 'unavailable' };
    }
    try {
      const result = await env.harnessDesktop.testCompletionNotification();
      return result?.sent === true
        ? { sent: true }
        : {
            sent: false,
            reason: DESKTOP_FAIL_REASONS.has(result?.reason) ? result.reason : 'failed',
          };
    } catch {
      return { sent: false, reason: 'failed' };
    }
  }

  const permission = await requestNotificationPermission(env);
  if (permission === 'unsupported') return { sent: false, reason: 'unsupported' };
  if (permission !== 'granted') return { sent: false, reason: 'permission-denied' };

  try {
    const notification = new env.Notification('Harness Gemini 系统通知测试', {
      body: '任务正常完成或异常结束时，会通过系统通知提醒你。',
      tag: 'harness-notification-test',
      silent: true,
    });
    notification.onclick = () => {
      try {
        env.focus?.();
      } catch {
        // Ignore window focus restrictions.
      }
      try {
        notification.close();
      } catch {
        // Ignore close errors.
      }
    };
    return { sent: true };
  } catch {
    return { sent: false, reason: 'failed' };
  }
}

function getOrCreateAudioContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioCtx();
  }
  return sharedAudioContext;
}

export function prepareCompletionSound() {
  try {
    const ctx = getOrCreateAudioContext();
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // Ignore audio context autoplay errors.
  }
}

export async function playCompletionSound() {
  try {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      let timer;
      try {
        await Promise.race([
          ctx.resume(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 800);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (ctx.state !== 'running') return false;

    const baseTime = ctx.currentTime + 0.01;
    const notes = [
      [0, 760, 0.14],
      [0.15, 1080, 0.1],
    ];

    for (const [offsetSec, freqHz, peakGain] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startAt = baseTime + offsetSec;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqHz * 0.55, startAt);
      osc.frequency.exponentialRampToValueAtTime(freqHz, startAt + 0.025);
      osc.frequency.exponentialRampToValueAtTime(freqHz * 0.6, startAt + 0.13);

      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.16);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(startAt);
      osc.stop(startAt + 0.17);
    }
    return true;
  } catch {
    return false;
  }
}

export function buildCompletionNotice(runEntry, completion) {
  if (
    !runEntry ||
    runEntry.stopping ||
    runEntry.deleted ||
    runEntry.deleting ||
    !completion ||
    !UUID_RE.test(completion.sessionId || '') ||
    !UUID_RE.test(completion.messageId || '') ||
    !['done', 'error'].includes(completion.status) ||
    (completion.status === 'done' && runEntry.hadError) ||
    completion.sessionId !== runEntry.sessionId ||
    (runEntry.assistantId && completion.messageId !== runEntry.assistantId) ||
    completion.mode !== runEntry.mode ||
    !COMPLETION_MODE_LABELS[completion.mode]
  ) {
    return null;
  }

  return {
    id: completion.messageId,
    sessionId: completion.sessionId,
    status: completion.status,
    label:
      completion.status === 'error'
        ? '任务异常结束'
        : COMPLETION_MODE_LABELS[completion.mode],
    title:
      (typeof completion.title === 'string' && completion.title.trim().slice(0, 120)) ||
      '新对话',
  };
}

export function createCompletionNotifier({
  getSettings,
  showPopup,
  openSession,
  playSound = playCompletionSound,
  prepareSound = prepareCompletionSound,
  environment = globalThis,
}) {
  const seenMessageIds = new Set();
  const seenRuns = new WeakSet();
  const activeSystemNotifications = new Set();

  return {
    prepare() {
      const settings = getSettings() || {};
      try {
        if (settings.completionSound !== false) {
          prepareSound();
        }
      } catch {
        // Ignore sound pre-warm error.
      }
      if (settings.completionNotification !== false) {
        requestNotificationPermission(environment).catch(() => {});
      }
    },

    notify(runEntry, completion) {
      const notice = buildCompletionNotice(runEntry, completion);
      if (!notice || seenMessageIds.has(notice.id) || seenRuns.has(runEntry)) {
        return false;
      }
      seenRuns.add(runEntry);
      seenMessageIds.add(notice.id);
      if (seenMessageIds.size > 256) {
        seenMessageIds.delete(seenMessageIds.values().next().value);
      }

      const settings = getSettings() || {};
      if (settings.completionSound !== false) {
        try {
          Promise.resolve(playSound()).catch(() => {});
        } catch {
          // Ignore sound playback error.
        }
      }

      if (settings.completionNotification !== false) {
        try {
          showPopup(notice);
        } catch {
          // Ignore UI toast error.
        }

        const capability = getNotificationCapability(environment);
        if (!capability.desktop && capability.permission === 'granted') {
          try {
            const sysNote = new environment.Notification(notice.label, {
              body: notice.title,
              tag: `harness-completed-${notice.id}`,
              silent: true,
            });
            activeSystemNotifications.add(sysNote);
            sysNote.onclose = () => activeSystemNotifications.delete(sysNote);
            sysNote.onclick = () => {
              try {
                environment.focus?.();
                openSession(notice.sessionId);
              } finally {
                sysNote.close();
                activeSystemNotifications.delete(sysNote);
              }
            };
          } catch {
            // Ignore system notification creation failure.
          }
        }
      }
      return true;
    },

    dispose() {
      for (const sysNote of activeSystemNotifications) {
        try {
          sysNote.close();
        } catch {
          // Ignore close failure.
        }
      }
      activeSystemNotifications.clear();
    },
  };
}
