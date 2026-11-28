/**
 * Harness Gemini UI - Settings Workbench Drawer & External Skills Management
 * License: MIT
 */

import {
  React,
  jsx,
  jsxs,
  Bell,
  Check,
  ChevronDown,
  CircleQuestionMark,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  Save,
  Settings2,
  Trash,
  TriangleAlert,
  Volume2,
  X,
} from '../vendor/vendor-deps.js';
import { createSettingsLayout, SETTINGS_SECTIONS } from '../settings-layout.js';
import {
  createAdvancedSettingsUI,
  advancedSavePatch,
  advancedValidationError,
  globalProxyError,
} from '../advanced-settings.js';
import { createSkillsUI } from '../skills-ui.js';
import { createUsageStatsUI } from '../usage-stats.js';
import { api } from './api.js';
import { SKINS, normalizeSkinId } from './themes.js';
import {
  getNotificationCapability,
  playCompletionSound,
  requestNotificationPermission,
  sendTestCompletionNotification,
} from './notifications.js';
import {
  API_PROTOCOLS,
  CONTEXT_WINDOW_PRESETS,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  REASONING_LEVELS,
  createSettingsDraft,
  getConfiguredModes,
  getReasoningLevelMeta,
  isProfileDirty,
  isValidHttpBaseUrl,
  normalizeProfileDraft,
  resolveReasoningEffort,
} from './model-utils.js';

const { SettingsNavigation, SettingsContent, ProviderConnections, useSettingsDialog } =
  createSettingsLayout(React);
const { AdvancedConnectionSettings, GlobalProxyField } = createAdvancedSettingsUI(React);
const { SkillsSettings } = createSkillsUI(React, api);
const { UsageStatsSettings } = createUsageStatsUI(React);

export function ExternalSkillsFieldset({ disabled = false, onToast }) {
  const [state, setState] = React.useState({
    loading: true,
    directory: '',
    skills: [],
    errors: [],
    error: '',
  });
  const [busyKey, setBusyKey] = React.useState('');

  const loadExternalSkills = React.useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await api.externalSkills();
      setState({
        loading: false,
        directory: res.directory,
        skills: res.skills,
        errors: res.errors,
        error: '',
      });
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, []);

  React.useEffect(() => {
    loadExternalSkills();
  }, [loadExternalSkills]);

  const handleToggleSkill = async (skillName, enabled) => {
    setBusyKey(skillName);
    try {
      const res = await api.setExternalSkill(skillName, enabled);
      setState({
        loading: false,
        directory: res.directory,
        skills: res.skills,
        errors: res.errors,
        error: '',
      });
    } catch (err) {
      onToast?.(err.message);
    } finally {
      setBusyKey('');
    }
  };

  return jsxs('fieldset', {
    className: 'external-skills-settings',
    children: [
      jsx('legend', { children: '外置技能' }),
      jsx('p', {
        className: 'external-skills-note',
        children:
          '放在技能文件夹里的脚本。模型能看到每个技能的说明，需要时会自己调用（工具名以 ext_ 开头）。 新增或修改后下一轮即可使用；也可以直接让模型「把这个脚本做成外置技能」。',
      }),
      jsxs('div', {
        className: 'external-skills-actions',
        children: [
          jsxs('button', {
            type: 'button',
            className: 'text-button',
            disabled: disabled || busyKey === 'open',
            onClick: async () => {
              setBusyKey('open');
              try {
                await api.openExternalSkillsFolder();
              } catch (err) {
                onToast?.(err.message);
              } finally {
                setBusyKey('');
              }
            },
            children: [
              busyKey === 'open'
                ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                : jsx(FolderOpen, { size: 13 }),
              '打开技能文件夹',
            ],
          }),
          jsxs('button', {
            type: 'button',
            className: 'text-button',
            disabled: disabled || state.loading,
            onClick: loadExternalSkills,
            children: [
              state.loading
                ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                : jsx(RefreshCw, { size: 13 }),
              '重新读取',
            ],
          }),
        ],
      }),
      state.directory &&
        jsx('small', {
          className: 'external-skills-path',
          title: state.directory,
          children: state.directory,
        }),
      state.error && jsx('p', { className: 'field-error', children: state.error }),
      !state.loading &&
        !state.error &&
        !state.skills.length &&
        jsx('p', {
          className: 'external-skills-empty',
          children: '还没有外置技能。打开技能文件夹，参照其中的 README.md 新建一个子文件夹即可。',
        }),
      state.skills.length > 0 &&
        jsx('ul', {
          className: 'external-skill-list',
          children: state.skills.map((skill) =>
            jsxs(
              'li',
              {
                className: `external-skill${skill.enabled ? '' : ' off'}`,
                children: [
                  jsx(Puzzle, {
                    size: 15,
                    className: 'external-skill-icon',
                    'aria-hidden': 'true',
                  }),
                  jsxs('div', {
                    className: 'external-skill-copy',
                    children: [
                      jsxs('div', {
                        className: 'external-skill-head',
                        children: [
                          jsx('strong', { children: skill.name }),
                          jsx('code', { children: skill.tool }),
                          skill.readOnly
                            ? jsx('span', {
                                className: 'external-skill-badge',
                                children: '只读',
                              })
                            : jsx('span', {
                                className: 'external-skill-badge write',
                                children: '可写',
                              }),
                        ],
                      }),
                      jsx('p', { title: skill.description, children: skill.description }),
                      jsxs('small', {
                        children: [
                          skill.command.join(' '),
                          skill.parameters.length ? ` · 参数：${skill.parameters.join('、')}` : '',
                        ],
                      }),
                    ],
                  }),
                  jsxs('label', {
                    className: 'external-skill-switch',
                    title: skill.manifestEnabled ? '' : 'skill.json 里设置了 enabled: false',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: skill.enabled,
                        disabled:
                          disabled || busyKey === skill.name || !skill.manifestEnabled,
                        onChange: (ev) => handleToggleSkill(skill.name, ev.target.checked),
                        'aria-label': `启用 ${skill.name}`,
                      }),
                      jsx('span', {
                        children:
                          busyKey === skill.name
                            ? jsx(LoaderCircle, { size: 12, className: 'spin' })
                            : skill.enabled
                              ? '已启用'
                              : '已停用',
                      }),
                    ],
                  }),
                ],
              },
              skill.name,
            ),
          ),
        }),
      state.errors.length > 0 &&
        jsx('ul', {
          className: 'external-skill-errors',
          children: state.errors.map((errItem) =>
            jsxs(
              'li',
              {
                children: [
                  jsx(TriangleAlert, { size: 13, 'aria-hidden': 'true' }),
                  jsxs('span', {
                    children: [jsx('strong', { children: errItem.folder }), '：', errItem.error],
                  }),
                ],
              },
              errItem.folder + errItem.error,
            ),
          ),
        }),
    ],
  });
}

export function SettingsDrawer({
  settings,
  skin,
  onSkinChange,
  onSkinSaved,
  onClose,
  onSaved,
  onToast,
  hasRunning = false,
}) {
  const [settingsSection, setSettingsSection] = React.useState('settings-models');
  const settingsDialogRef = useSettingsDialog();

  const [draft, setDraft] = React.useState(() => createSettingsDraft(settings));
  const [catalogMap, setCatalogMap] = React.useState({});
  const [saving, setSaving] = React.useState(false);
  const [saveMode, setSaveMode] = React.useState('save');
  const [formError, setFormError] = React.useState('');
  const [pendingRemoveId, setPendingRemoveId] = React.useState(null);
  const [notifCap, setNotifCap] = React.useState(getNotificationCapability);
  const [testingSound, setTestingSound] = React.useState(false);
  const [testingNotif, setTestingNotif] = React.useState(false);
  const [notifTestResult, setNotifTestResult] = React.useState(null);
  const [savingSkin, setSavingSkin] = React.useState(false);

  const skinBusyRef = React.useRef(false);
  const nameInputRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const savingRef = React.useRef(false);
  const draftRef = React.useRef(draft);
  const modelSeqRef = React.useRef({});
  const savedProfilesRef = React.useRef(draft.profiles.map((p) => ({ ...p })));
  const savedGlobalsRef = React.useRef({
    completionSound: draft.completionSound,
    completionNotification: draft.completionNotification,
    autoCompact: draft.autoCompact,
    fileChangesEnabled: draft.fileChangesEnabled,
    globalProxyUrl: draft.globalProxyUrl,
  });
  const soundBusyRef = React.useRef(false);
  const notifBusyRef = React.useRef(false);

  draftRef.current = draft;
  savingRef.current = saving;

  const selectedProfile =
    draft.profiles.find((p) => p.id === draft.selectedId) || draft.profiles[0];
  const savedSelectedProfile = savedProfilesRef.current.find((p) => p.id === selectedProfile.id);
  const hasValidBaseUrl = isValidHttpBaseUrl(selectedProfile.baseUrl);
  const modelCatalogEntry = catalogMap[selectedProfile.id] || {
    models: [],
    loading: false,
    error: '',
  };
  const discoveredModels = modelCatalogEntry.models || [];
  const pendingRemoveProfile = draft.profiles.find((p) => p.id === pendingRemoveId);

  const modifiedProfileCount = draft.profiles.filter((p) =>
    isProfileDirty(
      p,
      savedProfilesRef.current.find((saved) => saved.id === p.id),
    ),
  ).length;
  const deletedProfileCount = savedProfilesRef.current.filter(
    (saved) => !draft.profiles.some((p) => p.id === saved.id),
  ).length;

  const modeModelPairs = [
    ['聊天', selectedProfile.chatModel],
    ['编程', selectedProfile.agentModel],
  ]
    .map(([label, model]) => [label, String(model || '').trim()])
    .filter(([, model]) => model);

  const reasoningResolutions = modeModelPairs.map(([label, model]) => [
    label,
    model,
    resolveReasoningEffort(
      selectedProfile.reasoningEffort || '',
      model,
      selectedProfile.protocol || 'chat',
    ),
  ]);
  const reasoningSupportedPairs = reasoningResolutions.filter(([, , res]) => res.supported);
  const reasoningUnsupportedPairs = reasoningResolutions.filter(([, , res]) => !res.supported);

  const isUnlimitedRounds = draft.maxToolRounds === 0;
  const hasGlobalChanges =
    draft.completionSound !== savedGlobalsRef.current.completionSound ||
    draft.completionNotification !== savedGlobalsRef.current.completionNotification ||
    draft.autoCompact !== savedGlobalsRef.current.autoCompact ||
    draft.fileChangesEnabled !== savedGlobalsRef.current.fileChangesEnabled ||
    draft.globalProxyUrl !== savedGlobalsRef.current.globalProxyUrl;

  const showNotifUnpermittedHint =
    draft.completionNotification && !notifCap.desktop && notifCap.permission !== 'granted';

  React.useEffect(() => {
    mountedRef.current = true;
    nameInputRef.current?.focus();
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && !savingRef.current) {
        ev.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const handleSelectProfile = (profileId) => {
    setDraft((prev) => ({ ...prev, selectedId: profileId }));
    setPendingRemoveId(null);
    setFormError('');
  };

  const updateSelectedProfileField = (field, value) => {
    const targetId = selectedProfile.id;
    setDraft((prev) => ({
      ...prev,
      profiles: prev.profiles.map((p) => (p.id === targetId ? { ...p, [field]: value } : p)),
    }));
    if (
      ['baseUrl', 'apiKey', 'protocol', 'headers', 'proxyMode', 'proxyUrl'].includes(field)
    ) {
      modelSeqRef.current[targetId] = (modelSeqRef.current[targetId] || 0) + 1;
      setCatalogMap((prev) => ({
        ...prev,
        [targetId]: { models: [], loading: false, error: '' },
      }));
    }
  };

  const handleToggleCompletionNotification = async (checked) => {
    setDraft((prev) => ({ ...prev, completionNotification: checked }));
    const cap = getNotificationCapability();
    setNotifCap(cap);
    if (checked && !cap.desktop && cap.permission === 'default') {
      try {
        const perm = await requestNotificationPermission();
        if (mountedRef.current) {
          setNotifCap({ ...getNotificationCapability(), permission: perm });
        }
      } catch {
        if (mountedRef.current) setNotifCap(getNotificationCapability());
      }
    }
  };

  const handlePreviewSound = async () => {
    if (soundBusyRef.current || savingRef.current) return;
    soundBusyRef.current = true;
    setTestingSound(true);
    try {
      const ok = await playCompletionSound();
      if (mountedRef.current && !ok) {
        onToast('暂时无法播放提示音，请检查浏览器声音设置', 'error');
      }
    } catch {
      if (mountedRef.current) {
        onToast('暂时无法播放提示音，请检查浏览器声音设置', 'error');
      }
    } finally {
      soundBusyRef.current = false;
      if (mountedRef.current) setTestingSound(false);
    }
  };

  const handleTestNotification = async () => {
    if (notifBusyRef.current || savingRef.current) return;
    notifBusyRef.current = true;
    setTestingNotif(true);
    setNotifTestResult(null);

    const cap = getNotificationCapability();
    const fallbackError = cap.desktop
      ? '系统通知请求未完成，请检查 Windows 的通知设置后重试。'
      : '浏览器未能发送系统通知，请确认已允许此网站通知，并检查 Windows 通知设置。';

    try {
      const res = await sendTestCompletionNotification();
      if (!mountedRef.current) return;
      setNotifCap(getNotificationCapability());
      const reasonMessages = {
        unsupported: cap.desktop
          ? '当前 Windows 环境暂不支持系统通知。'
          : '当前浏览器不支持系统通知，请使用桌面版或支持通知的浏览器。',
        suppressed: '当前暂时无法发送系统通知，请稍后重试。',
        unavailable: '此版本的桌面通知功能不可用，请重新打开最新版 EXE。',
        failed: fallbackError,
        throttled: '请稍等片刻，再测试系统通知。',
        'permission-denied':
          '浏览器尚未允许此网站发送系统通知。请在网站权限中允许通知后重试。',
      };
      setNotifTestResult({
        error: !res.sent,
        message: res.sent
          ? '已请求发送 Windows 系统通知，请查看屏幕右下角'
          : reasonMessages[res.reason] || fallbackError,
      });
    } catch {
      if (mountedRef.current) {
        setNotifTestResult({ error: true, message: fallbackError });
      }
    } finally {
      notifBusyRef.current = false;
      if (mountedRef.current) setTestingNotif(false);
    }
  };

  const handleAddProfile = () => {
    if (draft.profiles.length >= 50) return;
    let index = 1;
    let candidateName = '新连接';
    while (draft.profiles.some((p) => p.name.trim() === candidateName)) {
      index += 1;
      candidateName = `新连接 ${index}`;
    }
    const created = normalizeProfileDraft({
      id: crypto.randomUUID(),
      name: candidateName,
    });
    setDraft((prev) => ({
      ...prev,
      profiles: [...prev.profiles, created],
      selectedId: created.id,
    }));
    setPendingRemoveId(null);
    setFormError('');
    requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const handleConfirmRemoveProfile = () => {
    if (!pendingRemoveId || draft.profiles.length <= 1) return;
    const remaining = draft.profiles.filter((p) => p.id !== pendingRemoveId);
    modelSeqRef.current[pendingRemoveId] = (modelSeqRef.current[pendingRemoveId] || 0) + 1;
    setDraft((prev) => ({
      ...prev,
      profiles: remaining,
      selectedId: prev.selectedId === pendingRemoveId ? remaining[0].id : prev.selectedId,
      activeProfileId:
        prev.activeProfileId === pendingRemoveId ? remaining[0].id : prev.activeProfileId,
    }));
    setPendingRemoveId(null);
    setFormError('');
  };

  const handleFetchModelsForDraft = async () => {
    if (!hasValidBaseUrl || savingRef.current || modelCatalogEntry.loading) return;
    const profileId = selectedProfile.id;
    const baseUrl = selectedProfile.baseUrl.trim();
    const apiKey = selectedProfile.apiKey.trim();
    const protocol = selectedProfile.protocol || 'chat';
    const proxySnapshot = JSON.stringify([
      selectedProfile.headers,
      selectedProfile.proxyMode,
      selectedProfile.proxyUrl,
      draft.globalProxyUrl,
    ]);

    const seq = (modelSeqRef.current[profileId] || 0) + 1;
    modelSeqRef.current[profileId] = seq;

    const isStillCurrent = () => {
      const latest = draftRef.current.profiles.find((p) => p.id === profileId);
      return (
        mountedRef.current &&
        modelSeqRef.current[profileId] === seq &&
        latest?.baseUrl.trim() === baseUrl &&
        latest?.apiKey.trim() === apiKey &&
        (latest?.protocol || 'chat') === protocol &&
        JSON.stringify([
          latest?.headers,
          latest?.proxyMode,
          latest?.proxyUrl,
          draftRef.current.globalProxyUrl,
        ]) === proxySnapshot
      );
    };

    setCatalogMap((prev) => ({
      ...prev,
      [profileId]: { ...prev[profileId], loading: true, error: '' },
    }));

    try {
      const payload = {
        baseUrl,
        protocol,
        headers: selectedProfile.headers,
        proxyMode: selectedProfile.proxyMode,
        proxyUrl: selectedProfile.proxyUrl,
        globalProxyUrl: draft.globalProxyUrl,
      };
      if (savedSelectedProfile) payload.profileId = profileId;
      if (apiKey) payload.apiKey = apiKey;

      const res = await api.modelsForDraft(payload);
      if (!isStillCurrent()) return;

      const seenIds = new Set();
      const loadedModels = (res.models || res.data || []).filter((item) => {
        if (typeof item?.id !== 'string' || !item.id || seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      });

      setCatalogMap((prev) => ({
        ...prev,
        [profileId]: {
          models: loadedModels,
          loading: false,
          error: loadedModels.length
            ? ''
            : '连接成功，但服务没有返回模型列表。也可以手动填写模型名称。',
        },
      }));
    } catch (err) {
      if (isStillCurrent()) {
        setCatalogMap((prev) => ({
          ...prev,
          [profileId]: { models: [], loading: false, error: err.message },
        }));
      }
    }
  };

  const handleSelectSkin = async (skinId) => {
    if (!mountedRef.current || savingRef.current || skinBusyRef.current) return;
    const normalized = normalizeSkinId(skinId);
    setDraft((prev) => ({ ...prev, skin: normalized }));
    onSkinChange?.(normalized);

    if (settings?.skin !== normalized) {
      skinBusyRef.current = true;
      setSavingSkin(true);
      try {
        const res = await api.saveSettings({ skin: normalized });
        if (!mountedRef.current) return;
        const nextSettings = Array.isArray(res?.profiles) ? res : await api.settings();
        onSkinSaved?.(nextSettings);
      } catch (err) {
        if (!mountedRef.current) return;
        setFormError(err.message);
        onSkinChange?.(normalizeSkinId(settings?.skin));
        setDraft((prev) => ({ ...prev, skin: normalizeSkinId(settings?.skin) }));
      } finally {
        skinBusyRef.current = false;
        if (mountedRef.current) setSavingSkin(false);
      }
    }
  };

  const validateAllProfiles = (requireSelectedBaseUrl) => {
    for (const profile of draft.profiles) {
      const advErr = advancedValidationError(profile);
      if (advErr) {
        setDraft((prev) => ({ ...prev, selectedId: profile.id }));
        setFormError(advErr);
        return false;
      }

      let errMsg = '';
      if (!profile.name.trim()) {
        errMsg = '请给这个连接起一个名称。';
      } else if (profile.baseUrl.trim() && !isValidHttpBaseUrl(profile.baseUrl)) {
        errMsg = '请填写有效的 HTTP 或 HTTPS API 地址，不要包含账号、密码或查询参数。';
      }
      if (!errMsg && !getConfiguredModes(profile).length) {
        errMsg = '每个连接的聊天、编程、生图模型至少填写一项，不使用的模式可留空。';
      }
      if (
        !errMsg &&
        (!Number.isSafeInteger(profile.contextWindow) ||
          profile.contextWindow < MIN_CONTEXT_WINDOW ||
          profile.contextWindow > MAX_CONTEXT_WINDOW)
      ) {
        errMsg = `请填写 ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} 到 ${MAX_CONTEXT_WINDOW.toLocaleString('en-US')} 之间的上下文窗口。`;
      }
      if (errMsg) {
        setDraft((prev) => ({ ...prev, selectedId: profile.id }));
        setFormError(errMsg);
        return false;
      }
    }

    if (requireSelectedBaseUrl && !selectedProfile.baseUrl.trim()) {
      setFormError('填写 API 地址并至少配置一种模型后，即可保存并使用。');
      return false;
    }
    if (!draft.workspace.trim()) {
      setFormError('请填写工作目录根。');
      return false;
    }
    const proxyErr = globalProxyError(draft.globalProxyUrl);
    if (proxyErr) {
      setFormError(proxyErr);
      return false;
    }
    if (!isUnlimitedRounds) {
      const rawRounds = String(draft.maxToolRounds).trim();
      const numRounds = Number(rawRounds);
      if (!rawRounds || !Number.isSafeInteger(numRounds) || numRounds < 1) {
        setFormError('限制轮次时，请填写有效的正整数。');
        return false;
      }
    }
    return true;
  };

  const handleSaveSettings = async (activateSelected = false) => {
    if (savingRef.current) return;
    setFormError('');
    if (!validateAllProfiles(activateSelected)) return;

    savingRef.current = true;
    setSaving(true);
    setSaveMode(activateSelected ? 'use' : 'save');

    try {
      const payload = {
        profiles: draft.profiles.map((profile) => {
          const item = {
            id: profile.id,
            name: profile.name.trim(),
            protocol: profile.protocol || 'chat',
            baseUrl: profile.baseUrl.trim(),
            chatModel: profile.chatModel.trim(),
            agentModel: profile.agentModel.trim(),
            imageModel: profile.imageModel.trim(),
            contextWindow: profile.contextWindow,
            reasoningEffort: profile.reasoningEffort || '',
            ...advancedSavePatch(profile),
          };
          if (profile.apiKey.trim()) {
            item.apiKey = profile.apiKey.trim();
          } else if (
            savedProfilesRef.current.find((saved) => saved.id === profile.id)?.apiKeySet
          ) {
            item.clearApiKey = true;
          }
          return item;
        }),
        activeProfileId: activateSelected ? selectedProfile.id : draft.activeProfileId,
        workspace: draft.workspace.trim(),
        maxToolRounds: isUnlimitedRounds ? 0 : Number(draft.maxToolRounds),
        completionSound: draft.completionSound,
        completionNotification: draft.completionNotification,
        autoCompact: draft.autoCompact,
        fileChangesEnabled: draft.fileChangesEnabled,
        globalProxyUrl: draft.globalProxyUrl.trim(),
      };

      const savedRes = await api.saveSettings(payload);
      const fullSettings = Array.isArray(savedRes?.profiles) ? savedRes : await api.settings();
      if (!mountedRef.current) return;

      const refreshedDraft = createSettingsDraft(fullSettings);
      refreshedDraft.selectedId = refreshedDraft.profiles.some((p) => p.id === selectedProfile.id)
        ? selectedProfile.id
        : refreshedDraft.activeProfileId;

      savedProfilesRef.current = refreshedDraft.profiles.map((p) => ({ ...p }));
      savedGlobalsRef.current = {
        completionSound: refreshedDraft.completionSound,
        completionNotification: refreshedDraft.completionNotification,
        autoCompact: refreshedDraft.autoCompact,
        fileChangesEnabled: refreshedDraft.fileChangesEnabled,
        globalProxyUrl: refreshedDraft.globalProxyUrl,
      };
      for (const p of refreshedDraft.profiles) {
        modelSeqRef.current[p.id] = (modelSeqRef.current[p.id] || 0) + 1;
      }

      setCatalogMap((prev) =>
        Object.fromEntries(
          refreshedDraft.profiles
            .filter((p) => prev[p.id])
            .map((p) => [p.id, { ...prev[p.id], loading: false }]),
        ),
      );
      setDraft(refreshedDraft);
      setPendingRemoveId(null);
      await onSaved(fullSettings);
      onToast(
        hasRunning
          ? '设置已保存，任务提醒已更新；模型设置从下一条消息生效'
          : activateSelected
            ? '已保存并切换到此连接'
            : '配置已保存',
      );
      if (activateSelected) onClose();
    } catch (err) {
      if (mountedRef.current) setFormError(err.message);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return jsx('div', {
    className: 'modal-backdrop settings-backdrop settings-workbench-backdrop',
    onMouseDown: (ev) => {
      if (ev.target === ev.currentTarget && !saving) onClose();
    },
    children: jsxs('section', {
      ref: settingsDialogRef,
      className: 'settings-drawer settings-workbench',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'settings-title',
      children: [
        jsxs('div', {
          className: 'drawer-header',
          children: [
            jsxs('div', {
              children: [
                jsx('span', {
                  className: 'drawer-icon',
                  children: jsx(Settings2, { size: 19 }),
                }),
                jsxs('div', {
                  children: [
                    jsx('h2', {
                      id: 'settings-title',
                      children:
                        SETTINGS_SECTIONS.find((item) => item.id === settingsSection)?.label ||
                        '设置',
                    }),
                    jsx('p', { children: '保存常用连接，随时切换模型。' }),
                  ],
                }),
              ],
            }),
            jsx('button', {
              className: 'icon-button',
              disabled: saving,
              onClick: onClose,
              title: '关闭设置',
              'aria-label': '关闭设置',
              children: jsx(X, { size: 19 }),
            }),
          ],
        }),
        jsxs('form', {
          onSubmit: (ev) => {
            ev.preventDefault();
            handleSaveSettings(false);
          },
          className: 'settings-form',
          children: [
            jsx(SettingsNavigation, {
              active: settingsSection,
              onSelect: setSettingsSection,
              profiles: draft.profiles,
              selectedId: selectedProfile.id,
              onSelectProvider: handleSelectProfile,
              disabled: saving,
            }),
            jsxs(SettingsContent, {
              className: 'settings-scroll',
              active: settingsSection,
              children: [
                jsx(ProviderConnections, {
                  'data-settings-section': 'settings-models',
                  profiles: draft.profiles,
                  selectedId: selectedProfile.id,
                  activeId: settings?.activeProfileId,
                  dirtyIds: draft.profiles
                    .filter((profile) =>
                      isProfileDirty(
                        profile,
                        savedProfilesRef.current.find((saved) => saved.id === profile.id),
                      ),
                    )
                    .map((profile) => profile.id),
                  disabled: saving,
                  onSelect: handleSelectProfile,
                  onAdd: handleAddProfile,
                  onRemove: () => setPendingRemoveId(selectedProfile.id),
                }),
                pendingRemoveProfile &&
                  jsxs('div', {
                    className: 'profile-delete-notice',
                    role: 'alert',
                    children: [
                      jsxs('p', {
                        children: [
                          '删除“',
                          pendingRemoveProfile.name || '未命名连接',
                          '”？保存设置后生效。',
                        ],
                      }),
                      jsxs('div', {
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: 'text-button',
                            onClick: () => setPendingRemoveId(null),
                            children: '保留配置',
                          }),
                          jsxs('button', {
                            type: 'button',
                            className: 'button button-danger small-button',
                            onClick: handleConfirmRemoveProfile,
                            children: [jsx(Trash, { size: 12 }), '移除配置'],
                          }),
                        ],
                      }),
                    ],
                  }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsx('span', { children: '配置名称' }),
                    jsx('input', {
                      ref: nameInputRef,
                      value: selectedProfile.name,
                      onChange: (ev) => updateSelectedProfileField('name', ev.target.value),
                      placeholder: '例如：日常聊天、图片创作',
                      maxLength: 80,
                      disabled: saving,
                      autoComplete: 'off',
                    }),
                  ],
                }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsx('span', { children: 'API 地址' }),
                    jsx('input', {
                      value: selectedProfile.baseUrl,
                      onChange: (ev) => updateSelectedProfileField('baseUrl', ev.target.value),
                      placeholder: 'http://127.0.0.1:8083/v1',
                      autoComplete: 'off',
                      spellCheck: 'false',
                      disabled: saving,
                    }),
                    jsx('small', { children: '填写服务提供的完整地址，通常以 /v1 结尾。' }),
                  ],
                }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsx('span', { children: 'API 协议' }),
                    jsxs('div', {
                      className: 'profile-select-wrap protocol-select-wrap',
                      children: [
                        jsx('select', {
                          'aria-label': '选择 API 协议',
                          value: selectedProfile.protocol || 'chat',
                          onChange: (ev) =>
                            updateSelectedProfileField('protocol', ev.target.value),
                          disabled: saving,
                          children: API_PROTOCOLS.map((proto) =>
                            jsxs(
                              'option',
                              {
                                value: proto.id,
                                children: [proto.label, '（', proto.path, '）'],
                              },
                              proto.id,
                            ),
                          ),
                        }),
                        jsx(ChevronDown, { size: 14 }),
                      ],
                    }),
                    jsx('small', {
                      children:
                        '按服务商支持的接口选择。Anthropic 兼容服务选 Messages，OpenAI 兼容服务通常选 Chat Completions。',
                    }),
                  ],
                }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsxs('span', {
                      children: [
                        'API Key ',
                        savedSelectedProfile?.apiKeySet &&
                          jsxs('span', {
                            className: 'saved-badge',
                            children: [jsx(Check, { size: 11 }), '此配置已保存密钥'],
                          }),
                      ],
                    }),
                    jsxs('div', {
                      className: 'input-with-icon',
                      children: [
                        jsx(KeyRound, { size: 16 }),
                        jsx('input', {
                          type: 'text',
                          name: `harness_api_key_${selectedProfile.id}`,
                          value: selectedProfile.apiKey,
                          onChange: (ev) => updateSelectedProfileField('apiKey', ev.target.value),
                          placeholder: '填写此配置的 API Key',
                          autoComplete: 'off',
                          spellCheck: 'false',
                          disabled: saving,
                        }),
                        savedSelectedProfile?.apiKeySet &&
                          selectedProfile.apiKey.includes('…') &&
                          typeof window.harnessDesktop?.revealApiKey === 'function' &&
                          jsx('button', {
                            type: 'button',
                            className: 'api-key-reveal',
                            disabled: saving,
                            title: '显示此连接已保存的完整 API Key',
                            onClick: async (ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              try {
                                const plainKey = await window.harnessDesktop.revealApiKey(
                                  selectedProfile.id,
                                );
                                if (plainKey) updateSelectedProfileField('apiKey', plainKey);
                              } catch (err) {
                                window.alert(err?.message || '暂时无法显示密钥。');
                              }
                            },
                            children: '显示',
                          }),
                      ],
                    }),
                    jsx('small', {
                      children:
                        '每个连接独立保存密钥；已保存的密钥只显示首尾几位，修改时请填写完整密钥。',
                    }),
                  ],
                }),
                jsx('p', {
                  className: 'model-fields-note',
                  id: 'model-fields-note',
                  children:
                    '每个连接至少填写一个模型。三个模式独立使用各自的模型，留空的模式不会显示在工作台。',
                }),
                jsxs('div', {
                  className: 'model-fields',
                  children: [
                    jsxs('label', {
                      className: 'field',
                      children: [
                        jsx('span', { children: '聊天模型' }),
                        jsx('input', {
                          list: `profile-models-${selectedProfile.id}`,
                          value: selectedProfile.chatModel,
                          onChange: (ev) =>
                            updateSelectedProfileField('chatModel', ev.target.value),
                          placeholder: '留空则不启用聊天',
                          'aria-describedby': 'model-fields-note',
                          spellCheck: 'false',
                          disabled: saving,
                        }),
                      ],
                    }),
                    jsxs('label', {
                      className: 'field',
                      children: [
                        jsx('span', { children: '推理等级' }),
                        jsxs('div', {
                          className: 'profile-select-wrap protocol-select-wrap',
                          children: [
                            jsxs('select', {
                              'aria-label': '选择推理等级',
                              value: selectedProfile.reasoningEffort || '',
                              onChange: (ev) =>
                                updateSelectedProfileField('reasoningEffort', ev.target.value),
                              disabled: saving,
                              children: [
                                jsx('option', { value: '', children: '使用模型默认值' }),
                                REASONING_LEVELS.map((lvl) =>
                                  jsxs(
                                    'option',
                                    {
                                      value: lvl.id,
                                      children: [lvl.label, '（', lvl.id, '）'],
                                    },
                                    lvl.id,
                                  ),
                                ),
                              ],
                            }),
                            jsx(ChevronDown, { size: 14 }),
                          ],
                        }),
                        jsxs('small', {
                          children: [
                            '从低到高：',
                            REASONING_LEVELS.map((lvl) => lvl.label).join(' → '),
                            '。属于此连接，不依赖聊天模型，未填写模型时也可以先选好；留空则不发送任何推理参数。',
                            reasoningSupportedPairs.length > 0 &&
                              ` 会用于：${reasoningSupportedPairs
                                .map(([mLabel, mId, res]) => {
                                  if (res.clamped) {
                                    const reqLabel =
                                      getReasoningLevelMeta(res.requested)?.label || res.requested;
                                    const effLabel =
                                      getReasoningLevelMeta(res.effective)?.label || res.effective;
                                    return `${mLabel}「${mId}」（不支持${reqLabel}，将自动按${effLabel}发送）`;
                                  }
                                  if (res.effective) {
                                    const effLabel =
                                      getReasoningLevelMeta(res.effective)?.label || res.effective;
                                    return `${mLabel}「${mId}」（${effLabel}）`;
                                  }
                                  const capText = res.supportedIds
                                    .map((id) => getReasoningLevelMeta(id)?.label || id)
                                    .join('/');
                                  return `${mLabel}「${mId}」（支持：${capText}）`;
                                })
                                .join('、')}。`,
                            reasoningUnsupportedPairs.length > 0 &&
                              ` ${reasoningUnsupportedPairs
                                .map(([mLabel, mId]) => `${mLabel}「${mId}」`)
                                .join('、')}不被识别为支持推理等级，向它发送的请求不带此参数。`,
                            ' ',
                            '生图请求从不发送推理参数。',
                          ],
                        }),
                      ],
                    }),
                    jsxs('label', {
                      className: 'field',
                      children: [
                        jsx('span', { children: '编程模型' }),
                        jsx('input', {
                          list: `profile-models-${selectedProfile.id}`,
                          value: selectedProfile.agentModel,
                          onChange: (ev) =>
                            updateSelectedProfileField('agentModel', ev.target.value),
                          placeholder: '留空则不启用编程',
                          'aria-describedby': 'model-fields-note',
                          spellCheck: 'false',
                          disabled: saving,
                        }),
                      ],
                    }),
                    jsxs('label', {
                      className: 'field',
                      children: [
                        jsx('span', { children: '生图模型' }),
                        jsx('input', {
                          list: `profile-models-${selectedProfile.id}`,
                          value: selectedProfile.imageModel,
                          onChange: (ev) =>
                            updateSelectedProfileField('imageModel', ev.target.value),
                          placeholder: '留空则不启用生图',
                          'aria-describedby': 'model-fields-note',
                          spellCheck: 'false',
                          disabled: saving,
                        }),
                      ],
                    }),
                    jsx('datalist', {
                      id: `profile-models-${selectedProfile.id}`,
                      children: discoveredModels.map((item) =>
                        jsx('option', { value: item.id }, item.id),
                      ),
                    }),
                  ],
                }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsx('span', { children: '上下文窗口' }),
                    jsxs('div', {
                      className: 'context-window-field',
                      children: [
                        jsx('input', {
                          type: 'number',
                          min: MIN_CONTEXT_WINDOW,
                          max: MAX_CONTEXT_WINDOW,
                          step: '1000',
                          value: selectedProfile.contextWindow,
                          onChange: (ev) =>
                            updateSelectedProfileField(
                              'contextWindow',
                              ev.target.value === '' ? '' : Number(ev.target.value),
                            ),
                          'aria-describedby': 'context-window-note',
                          disabled: saving,
                        }),
                        jsx('div', {
                          className: 'context-window-presets',
                          children: CONTEXT_WINDOW_PRESETS.map((preset) =>
                            jsx(
                              'button',
                              {
                                type: 'button',
                                className:
                                  selectedProfile.contextWindow === preset ? 'selected' : '',
                                disabled: saving,
                                onClick: () => updateSelectedProfileField('contextWindow', preset),
                                children: new Intl.NumberFormat('en-US', {
                                  notation: 'compact',
                                }).format(preset),
                              },
                              preset,
                            ),
                          ),
                        }),
                      ],
                    }),
                    jsx('small', {
                      id: 'context-window-note',
                      children:
                        '此连接的模型一次能接收的 token 上限，用于显示上下文占用并在接近上限时自动压缩。不确定时保持默认值。',
                    }),
                  ],
                }),
                jsxs('div', {
                  className: 'load-models-row',
                  children: [
                    jsxs('button', {
                      type: 'button',
                      className: 'text-button',
                      disabled: saving || modelCatalogEntry.loading || !hasValidBaseUrl,
                      onClick: handleFetchModelsForDraft,
                      children: [
                        modelCatalogEntry.loading
                          ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                          : jsx(RefreshCw, { size: 13 }),
                        '读取此连接的模型',
                      ],
                    }),
                    jsx('span', {
                      children: hasValidBaseUrl
                        ? discoveredModels.length
                          ? `发现 ${discoveredModels.length} 个模型`
                          : '无需保存，也可以直接填写模型名称'
                        : '填写有效的 API 地址后即可读取',
                    }),
                  ],
                }),
                modelCatalogEntry.error &&
                  jsx('p', { className: 'field-error', children: modelCatalogEntry.error }),
                jsx(AdvancedConnectionSettings, {
                  profile: selectedProfile,
                  disabled: saving,
                  onChange: updateSelectedProfileField,
                  globalProxyUrl: draft.globalProxyUrl,
                }),
                jsxs('div', {
                  className: 'settings-section-title',
                  'data-settings-section': 'settings-workspace',
                  children: [
                    jsx('span', { children: '全局工作区' }),
                    jsx('span', { className: 'section-line' }),
                  ],
                }),
                jsxs('label', {
                  className: 'field',
                  children: [
                    jsx('span', { children: '工作目录根' }),
                    jsxs('div', {
                      className: 'input-with-icon',
                      children: [
                        jsx(FolderOpen, { size: 16 }),
                        jsx('input', {
                          value: draft.workspace,
                          onChange: (ev) =>
                            setDraft((prev) => ({ ...prev, workspace: ev.target.value })),
                          placeholder: 'C:\\Projects\\my-project',
                          spellCheck: 'false',
                          disabled: saving,
                        }),
                      ],
                    }),
                    jsx('small', {
                      children:
                        '每个会话在此目录下的 sessions 子目录中独立工作；修改只影响之后新建的会话。',
                    }),
                  ],
                }),
                jsx(GlobalProxyField, {
                  value: draft.globalProxyUrl,
                  disabled: saving,
                  onChange: (nextUrl) => {
                    for (const p of draft.profiles) {
                      modelSeqRef.current[p.id] = (modelSeqRef.current[p.id] || 0) + 1;
                    }
                    setCatalogMap({});
                    setDraft((prev) => ({ ...prev, globalProxyUrl: nextUrl }));
                  },
                }),
                jsxs('fieldset', {
                  className: 'tool-round-settings',
                  children: [
                    jsx('legend', { children: '工具调用轮次' }),
                    jsxs('div', {
                      className: 'tool-round-options',
                      children: [
                        jsxs('label', {
                          className: `tool-round-choice${isUnlimitedRounds ? ' selected' : ''}`,
                          children: [
                            jsx('input', {
                              type: 'radio',
                              name: 'harness_tool_round_mode',
                              checked: isUnlimitedRounds,
                              disabled: saving,
                              onChange: () =>
                                setDraft((prev) => ({
                                  ...prev,
                                  limitedToolRounds:
                                    prev.maxToolRounds === 0
                                      ? prev.limitedToolRounds
                                      : String(prev.maxToolRounds),
                                  maxToolRounds: 0,
                                })),
                            }),
                            jsx('span', { children: '无限制' }),
                          ],
                        }),
                        jsxs('label', {
                          className: `tool-round-choice${isUnlimitedRounds ? '' : ' selected'}`,
                          children: [
                            jsx('input', {
                              type: 'radio',
                              name: 'harness_tool_round_mode',
                              checked: !isUnlimitedRounds,
                              disabled: saving,
                              onChange: () =>
                                setDraft((prev) => ({
                                  ...prev,
                                  maxToolRounds: prev.limitedToolRounds,
                                })),
                            }),
                            jsx('span', { children: '限制轮次' }),
                          ],
                        }),
                      ],
                    }),
                    !isUnlimitedRounds &&
                      jsxs('label', {
                        className: 'field tool-round-field',
                        children: [
                          jsx('span', { children: '最多工具轮次' }),
                          jsx('input', {
                            type: 'number',
                            min: '1',
                            step: '1',
                            value: draft.maxToolRounds,
                            onChange: (ev) =>
                              setDraft((prev) => ({
                                ...prev,
                                maxToolRounds: ev.target.value,
                                limitedToolRounds: ev.target.value,
                              })),
                            disabled: saving,
                          }),
                        ],
                      }),
                    jsx('p', {
                      children: '全部连接共用；无限制会持续调用直到完成或手动停止。',
                    }),
                  ],
                }),
                jsxs('fieldset', {
                  className: 'compaction-settings',
                  children: [
                    jsx('legend', { children: '上下文压缩' }),
                    jsx('div', {
                      className: 'completion-options',
                      children: jsxs('label', {
                        className: 'completion-choice',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            checked: draft.autoCompact,
                            disabled: saving,
                            onChange: (ev) =>
                              setDraft((prev) => ({ ...prev, autoCompact: ev.target.checked })),
                          }),
                          jsx('span', { children: '接近上限时自动压缩' }),
                        ],
                      }),
                    }),
                    jsx('p', {
                      className: 'completion-note',
                      children:
                        '开启后，上下文接近上限时会自动把较早的历史替换为摘要，最近的消息保持原样。关闭后仍可在输入框发送 /compact 手动压缩。压缩只影响发送给模型的内容，对话记录本身不会删除。',
                    }),
                  ],
                }),
                jsxs('fieldset', {
                  className: 'compaction-settings file-changes-settings',
                  children: [
                    jsx('legend', { children: '文件改动接口' }),
                    jsx('div', {
                      className: 'completion-options',
                      children: jsxs('label', {
                        className: 'completion-choice',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            checked: draft.fileChangesEnabled,
                            disabled: saving,
                            onChange: (ev) =>
                              setDraft((prev) => ({
                                ...prev,
                                fileChangesEnabled: ev.target.checked,
                              })),
                          }),
                          jsx('span', { children: '启用文件改动记录与撤回接口' }),
                        ],
                      }),
                    }),
                    jsx('p', {
                      className: 'completion-note',
                      children:
                        '开启后，调用 write_file、download_file 修改文件时会自动保存改动快照，并在右侧“产物”面板提供查看差异与撤回接口。关闭后将停止记录并关闭文件改动接口。',
                    }),
                  ],
                }),
                jsxs('fieldset', {
                  className: 'completion-settings',
                  'data-settings-section': 'settings-reminders',
                  children: [
                    jsx('legend', { children: '任务结束提醒' }),
                    jsxs('div', {
                      className: 'completion-options',
                      children: [
                        jsxs('label', {
                          className: 'completion-choice',
                          children: [
                            jsx('input', {
                              type: 'checkbox',
                              checked: draft.completionSound,
                              disabled: saving,
                              onChange: (ev) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  completionSound: ev.target.checked,
                                })),
                            }),
                            jsx('span', { children: '气泡提示音' }),
                          ],
                        }),
                        jsxs('button', {
                          type: 'button',
                          className: 'text-button completion-preview',
                          onClick: handlePreviewSound,
                          disabled: saving || testingSound,
                          'aria-label': '试听气泡提示音',
                          children: [
                            testingSound
                              ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                              : jsx(Volume2, { size: 13 }),
                            '试听',
                          ],
                        }),
                        jsxs('label', {
                          className: 'completion-choice',
                          children: [
                            jsx('input', {
                              type: 'checkbox',
                              checked: draft.completionNotification,
                              disabled: saving,
                              onChange: (ev) =>
                                handleToggleCompletionNotification(ev.target.checked),
                            }),
                            jsx('span', { children: '系统通知' }),
                          ],
                        }),
                        jsxs('button', {
                          type: 'button',
                          className: 'text-button completion-system-test',
                          onClick: handleTestNotification,
                          disabled: saving || testingNotif,
                          children: [
                            testingNotif
                              ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                              : jsx(Bell, { size: 13 }),
                            '测试系统通知',
                          ],
                        }),
                      ],
                    }),
                    jsxs('p', {
                      className: 'completion-note',
                      children: [
                        '正常完成或异常结束时提醒，手动停止不提醒。保存后生效。',
                        showNotifUnpermittedHint && '系统通知未开启，工作台内仍会显示结束提示。',
                      ],
                    }),
                    notifTestResult &&
                      jsx('p', {
                        className: `completion-test-result${notifTestResult.error ? ' error' : ''}`,
                        role: 'status',
                        children: notifTestResult.message,
                      }),
                  ],
                }),
                jsx(SkillsSettings, {
                  disabled: saving,
                  onToast,
                  'data-settings-section': 'settings-skills',
                }),
                jsx(UsageStatsSettings, {
                  'data-settings-section': 'settings-usage',
                }),
                jsxs('div', {
                  className: 'settings-section-title',
                  'data-settings-section': 'settings-appearance',
                  children: [
                    jsx('span', { children: '界面皮肤' }),
                    jsx('span', { className: 'section-line' }),
                    savingSkin &&
                      jsxs('span', {
                        className: 'skin-saving',
                        children: [
                          jsx(LoaderCircle, { size: 11, className: 'spin' }),
                          '保存中',
                        ],
                      }),
                  ],
                }),
                jsx('div', {
                  className: 'skin-picker',
                  role: 'radiogroup',
                  'aria-label': '界面皮肤',
                  children: SKINS.map((skinItem) =>
                    jsxs(
                      'button',
                      {
                        type: 'button',
                        role: 'radio',
                        'aria-checked': draft.skin === skinItem.id,
                        className: `skin-option${draft.skin === skinItem.id ? ' selected' : ''}`,
                        disabled: saving || savingSkin,
                        onClick: () => handleSelectSkin(skinItem.id),
                        children: [
                          jsxs('span', {
                            className: 'skin-preview',
                            'data-preview': skinItem.id,
                            'aria-hidden': 'true',
                            children: [
                              jsx('i', { className: 'skin-preview-bar' }),
                              jsx('i', { className: 'skin-preview-card' }),
                              skinItem.swatches.map((color) =>
                                jsx('i', { style: { background: color } }, color),
                              ),
                            ],
                          }),
                          jsxs('span', {
                            className: 'skin-copy',
                            children: [
                              jsx('strong', { children: skinItem.name }),
                              jsx('small', { children: skinItem.tone }),
                              jsx('em', { children: skinItem.description }),
                            ],
                          }),
                          draft.skin === skinItem.id &&
                            jsx('span', {
                              className: 'skin-check',
                              children: jsx(Check, { size: 13 }),
                            }),
                        ],
                      },
                      skinItem.id,
                    ),
                  ),
                }),
                jsx('p', {
                  className: 'skin-note',
                  children: '换肤立即生效，并随设置保存，下次打开保持一致。布局与功能完全相同。',
                }),
                jsxs('div', {
                  className: 'settings-note',
                  children: [
                    jsx(CircleQuestionMark, { size: 16 }),
                    jsx('p', {
                      children:
                        '填好地址即可试读模型列表，需要密钥的服务请一并填写。试读不会保存配置，仅在已保存连接的地址未变时复用原有密钥。至少选择一个模型后，点击“保存并使用”。',
                    }),
                  ],
                }),
              ],
            }),
            jsx('div', {
              className: 'settings-save-status',
              children: formError
                ? jsx('div', { className: 'form-error', role: 'alert', children: formError })
                : modifiedProfileCount || deletedProfileCount
                  ? jsxs('span', {
                      children: [
                        '有未保存的连接更改',
                        deletedProfileCount ? `，包含 ${deletedProfileCount} 个待删除配置` : '',
                      ],
                    })
                  : hasGlobalChanges
                    ? jsx('span', {
                        children: '有未保存的任务提醒、压缩或文件改动设置更改',
                      })
                    : jsx('span', {
                        children: '工作目录、工具轮次、任务提醒、压缩与文件改动设置为全局设置',
                      }),
            }),
            jsxs('div', {
              className: 'drawer-footer profile-editor-footer',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'button button-quiet',
                  disabled: saving,
                  onClick: onClose,
                  children: '取消',
                }),
                jsxs('button', {
                  type: 'submit',
                  className: 'button button-quiet',
                  disabled: saving,
                  children: [
                    saving && saveMode === 'save'
                      ? jsx(LoaderCircle, { size: 14, className: 'spin' })
                      : jsx(Save, { size: 14 }),
                    '保存配置',
                  ],
                }),
                jsxs('button', {
                  type: 'button',
                  className: 'button button-primary',
                  disabled: saving,
                  onClick: () => handleSaveSettings(true),
                  children: [
                    saving && saveMode === 'use'
                      ? jsx(LoaderCircle, { size: 14, className: 'spin' })
                      : jsx(Check, { size: 14 }),
                    '保存并使用',
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  });
}
