// ==UserScript==
// @name         菜大师boss海投助手
// @namespace    https://github.com/ZionCai/CaiMaster-BossQuickApply
// @version      2.1.0
// @description  BOSS直聘高效投递工具：AI智能招呼语 + 半自动投递 + 批量海投 + 简历导入
// @author       Zion Cai
// @match        https://www.zhipin.com/*
// @match        https://zhipin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @connect      zhipin.com
// @connect      *
// @license      MIT
// @noframes
// @supportURL   https://github.com/ZionCai/CaiMaster-BossQuickApply/issues
// ==/UserScript==

/**
 * v2.1.0 更新要点
 * 1. 修复页面识别：兼容 /web/geek/job 与 /web/geek/jobs 两种职位页地址（旧版只认 /jobs，导致在 /job 页面上"什么都不做"）
 * 2. 修复配置丢失：设置项全部纳入统一持久化，刷新后不再清空（旧版刷新后 API/简历/模板会被空值覆盖）
 * 3. 修复面板/欢迎信不弹出：移除调试用 alert、增加注入重试与单页路由监听
 * 4. 修复"只找不投递"：改为按 jobId 实时重查 DOM，多选择器兜底，并校验投递结果
 * 5. 修复 AI 请求：systemRole 不再被覆盖，增加超时/重试/友好报错
 */
 
(function () {
  "use strict";
 
  /**
   * @typedef {Object} HRInteraction
   * @property {string} hrKey - HR唯一标识
   * @property {boolean} hasGreeted - 是否已打招呼
   * @property {boolean} hasSentResume - 是否已发送简历
   * @property {boolean} hasSentImageResume - 是否已发送图片简历
   */
 
  /**
   * @typedef {Object} JobInfo
   * @property {string} jobId - 职位ID
   * @property {string} title - 职位标题
   * @property {string} company - 公司名称
   * @property {string} salary - 薪资范围
   * @property {string} location - 工作地点
   * @property {string} hrKey - HR标识
   */
 
  /**
   * @typedef {Object} GreetingItem
   * @property {string} id - 问候语ID
   * @property {string} content - 问候语内容
   */
 
  /**
   * @typedef {Object} ImageResume
   * @property {string} id - 图片简历ID
   * @property {string} name - 图片简历名称
   * @property {string} data - Base64编码的图片数据
   */
 
  /**
   * @typedef {Object} ErrorInfo
   * @property {string} message - 错误消息
   * @property {string} stack - 错误堆栈
   * @property {string} context - 错误上下文
   * @property {string} timestamp - 时间戳
   */
 
  const CONFIG = {
    BASIC_INTERVAL: 1000,
    OPERATION_INTERVAL: 1200,

    DELAYS: {
      SHORT: 30,
      MEDIUM_SHORT: 200,
    },
    MINI_ICON_SIZE: 40,
    STORAGE_KEYS: {
      PROCESSED_HRS: "processedHRs",
      SENT_GREETINGS_HRS: "sentGreetingsHRs",
      SENT_RESUME_HRS: "sentResumeHRs",
      SENT_IMAGE_RESUME_HRS: "sentImageResumeHRs",
      AI_REPLY_COUNT: "aiReplyCount",
      LAST_AI_DATE: "lastAiDate",
    },
    STORAGE_LIMITS: {
      PROCESSED_HRS: 500,
      SENT_GREETINGS_HRS: 500,
      SENT_RESUME_HRS: 300,
      SENT_IMAGE_RESUME_HRS: 300,
    },

    API: {
      TIMEOUT: 20000,
      BASE_URL: 'https://leafboss.top/api',
      RETRY_COUNT: 3,
      RETRY_DELAY: 1000
    },

    UI: {
      MINI_ICON_SIZE: 40,
      ANIMATION_DURATION: 300,
      DEBOUNCE_DELAY: 300
    },

    PERFORMANCE: {
      DOM_CACHE_MAX_AGE: 5000,
      BATCH_SIZE: 10,
      CONCURRENT_LIMIT: 3
    },

    // 单次运行的安全上限，避免被风控
    SAFETY: {
      MAX_APPLY_PER_RUN: 50,
      MAX_SCROLL_STEPS: 30,
      APPLY_INTERVAL: 2500,
    }
  };

  /* =========================================================================
   * 页面识别 —— v2.1.0 修复点
   * 旧版全部使用 location.pathname.includes("/jobs") 判断，
   * 但 BOSS 搜索结果页的实际地址是 /web/geek/job（无 s），
   * 导致 Core.startProcessing 里两个分支都不命中：脚本"只是在找，不会投递"。
   * ========================================================================= */
  const PAGE = {
    isChat() {
      return location.pathname.indexOf("/chat") !== -1;
    },
    isGreetSettings() {
      return location.pathname.indexOf("/notify-set") !== -1;
    },
    isJobDetail() {
      return location.pathname.indexOf("/job_detail/") !== -1;
    },
    /** 职位列表页：/web/geek/job、/web/geek/jobs、/web/geek/recommend、/job_detail/xxx */
    isJobList() {
      const p = location.pathname;
      if (PAGE.isChat() || PAGE.isGreetSettings()) return false;
      return (
        /\/web\/geek\/jobs?(\/|$)/.test(p) ||
        /\/web\/geek\/recommend/.test(p) ||
        /\/web\/geek\/job-list/.test(p) ||
        PAGE.isJobDetail()
      );
    },
    isSupported() {
      return PAGE.isJobList() || PAGE.isChat() || PAGE.isGreetSettings();
    },
    /** 页面标识，用于单页路由切换时判断是否需要重建面板 */
    key() {
      if (PAGE.isChat()) return "chat";
      if (PAGE.isGreetSettings()) return "greet-set";
      if (PAGE.isJobList()) return "job-list";
      return "other";
    },
  };

  const getStoredJSON = (key, defaultValue) => {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch (e) {
      console.error(`Error parsing ${key}:`, e);
      return defaultValue;
    }
  };
 
  const state = {
    isRunning: false,
    currentIndex: 0,
 
    includeKeywords: [],
    locationKeywords: [],
 
    jobList: [],
 
    ui: {
      isMinimized: false,
      theme: localStorage.getItem("theme") || "light",
    },
 
    hrInteractions: {
      processedHRs: new Set(getStoredJSON("processedHRs", [])),
      sentGreetingsHRs: new Set(getStoredJSON("sentGreetingsHRs", [])),
      sentResumeHRs: new Set(getStoredJSON("sentResumeHRs", [])),
      sentImageResumeHRs: new Set(getStoredJSON("sentImageResumeHRs", [])),
    },
 
    ai: {
      replyCount: getStoredJSON("aiReplyCount", 0),
      lastAiDate: localStorage.getItem("lastAiDate") || "",
      useAiReply: true,
    },
 
    // 注意：这里只是占位，脚本加载后会被 state.settings = settings 覆盖为唯一配置对象
    settings: {},

    // 运行统计（面板底部展示）
    stats: {
      greeted: 0,
      resumed: 0,
      skipped: 0,
      failed: 0,
      startTime: 0,
    },

    // 当前正在处理的职位标识，用于 AI 招呼语 → 一键投递 的衔接
    currentJobKey: null,
    currentJobTitle: "",

    activation: {
      isActivated: localStorage.getItem("activationStatus") === "true",
      activationCode: localStorage.getItem("activationCode") || "",
      cardKey: localStorage.getItem("cardKey") || "",
      activatedAt: localStorage.getItem("activationDate") || "",
    },

    comments: {
      currentCompanyName: "",
      commentsList: [],
      isLoading: false,
      isCommentMode: false,
    },

    securityIdCache: new Map(),
  };

  const elements = {
    panel: null,
    controlBtn: null,
    log: null,
    includeInput: null,
    locationInput: null,
    miniIcon: null,
  };
 
  class ErrorHandler {
    static handle(error, context = '') {
      const errorInfo = {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString()
      };
 
      console.error(`[${context}]`, error);
 
      if (state.settings && state.settings.errorReporting) {
        this.report(errorInfo);
      }
 
      return errorInfo;
    }
 
    static async wrap(fn, context) {
      try {
        return await fn();
      } catch (error) {
        return this.handle(error, context);
      }
    }
 
    static report(errorInfo) {
      console.log('Error reported:', errorInfo);
    }
  }
 
  class APIInterceptor {
    static init() {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
 
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this._url = url;
        this._method = method;
        return originalOpen.apply(this, [method, url, ...args]);
      };
 
      XMLHttpRequest.prototype.send = function (...args) {
        if (this._url && this._url.includes('/wapi/zpgeek/job/detail.json')) {
          const urlObj = new URL(this._url, window.location.origin);
          const securityId = urlObj.searchParams.get('securityId');
          const lid = urlObj.searchParams.get('lid');
 
          if (securityId) {
            const jobIdMatch = this._url.match(/job_detail\/([^.]+)\.html/);
            const jobId = jobIdMatch ? jobIdMatch[1] : null;
 
            state.securityIdCache.set('current', {
              securityId,
              lid,
              jobId,
              timestamp: Date.now()
            });
 
            console.log(`[API拦截器] 捕获securityId: ${securityId.substring(0, 20)}...`);
          }
        }
 
        return originalSend.apply(this, args);
      };
 
      console.log('[API拦截器] 已启动');
    }
 
    static getCurrentSecurityId() {
      const cached = state.securityIdCache.get('current');
      if (cached && Date.now() - cached.timestamp < 300000) {
        return cached;
      }
      return null;
    }
  }
 
  class DOMCache {
    static cache = new Map();
    static maxAge = CONFIG.PERFORMANCE.DOM_CACHE_MAX_AGE;
 
    static get(selector) {
      const cached = this.cache.get(selector);
      if (cached && Date.now() - cached.time < this.maxAge) {
        return cached.element;
      }
 
      const element = document.querySelector(selector);
      if (element) {
        this.cache.set(selector, { element, time: Date.now() });
      }
      return element;
    }
 
    static getAll(selector) {
      return document.querySelectorAll(selector);
    }
 
    static clear() {
      this.cache.clear();
    }
 
    static remove(selector) {
      this.cache.delete(selector);
    }
  }
 
  class ManagedSet {
    constructor(maxSize = 500) {
      this.items = new Set();
      this.maxSize = maxSize;
    }
 
    add(item) {
      if (this.items.size >= this.maxSize) {
        const firstItem = this.items.values().next().value;
        this.items.delete(firstItem);
      }
      this.items.add(item);
    }
 
    has(item) {
      return this.items.has(item);
    }
 
    delete(item) {
      return this.items.delete(item);
    }
 
    clear() {
      this.items.clear();
    }
 
    get size() {
      return this.items.size;
    }
 
    toArray() {
      return Array.from(this.items);
    }
  }
 
  class EventManager {
    static listeners = new Map();
 
    static add(element, event, handler, options = {}) {
      const key = `${element.id || element.className || element.tagName}-${event}-${Date.now()}`;
 
      if (this.listeners.has(key)) {
        this.remove(key);
      }
 
      element.addEventListener(event, handler, options);
      this.listeners.set(key, { element, event, handler });
      return key;
    }
 
    static remove(key) {
      const listener = this.listeners.get(key);
      if (listener) {
        listener.element.removeEventListener(
          listener.event,
          listener.handler
        );
        this.listeners.delete(key);
      }
    }
 
    static removeAll() {
      this.listeners.forEach((_, key) => this.remove(key));
    }
 
    static getByElement(element) {
      const results = [];
      this.listeners.forEach((listener, key) => {
        if (listener.element === element) {
          results.push({ key, ...listener });
        }
      });
      return results;
    }
  }
 
  class DOMUtils {
    static async waitForAndAct(selector, action, options = {}) {
      const {
        timeout = 5000,
        retryInterval = 100,
        maxRetries = 3
      } = options;
 
      for (let i = 0; i < maxRetries; i++) {
        try {
          const element = await Core.waitForElement(selector, timeout);
          if (element) {
            const result = await action(element);
            return result;
          }
        } catch (error) {
          if (i === maxRetries - 1) throw error;
          await Core.delay(retryInterval);
        }
      }
      return null;
    }
 
    static async clickElement(selector, options = {}) {
      return this.waitForAndAct(selector, async (element) => {
        await Core.simulateClick(element);
        return true;
      }, options);
    }
 
    static async inputText(selector, text, options = {}) {
      return this.waitForAndAct(selector, async (element) => {
        element.textContent = "";
        element.focus();
        document.execCommand("insertText", false, text);
        return true;
      }, options);
    }
 
    static debounce(fn, delay = CONFIG.UI.DEBOUNCE_DELAY) {
      let timer = null;
      return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    }
 
    static throttle(fn, delay = CONFIG.UI.DEBOUNCE_DELAY) {
      let lastTime = 0;
      return function (...args) {
        const now = Date.now();
        if (now - lastTime >= delay) {
          lastTime = now;
          return fn.apply(this, args);
        }
      };
    }
  }
 
  class StorageManager {
    static setItem(key, value) {
      try {
        localStorage.setItem(
          key,
          typeof value === "string" ? value : JSON.stringify(value)
        );
        return true;
      } catch (error) {
        Core.log(`设置存储项 ${key} 失败: ${error.message}`);
        return false;
      }
    }
 
    static getItem(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(key);
        return value !== null ? value : defaultValue;
      } catch (error) {
        Core.log(`获取存储项 ${key} 失败: ${error.message}`);
        return defaultValue;
      }
    }
 
    static addRecordWithLimit(storageKey, record, currentSet, limit) {
      try {
        if (currentSet.has(record)) {
          return;
        }
 
        let records = this.getParsedItem(storageKey, []);
        records = Array.isArray(records) ? records : [];
 
        if (records.length >= limit) {
          records.shift();
        }
 
        records.push(record);
        currentSet.add(record);
        this.setItem(storageKey, records);
 
        console.log(
          `存储管理: 添加记录${records.length >= limit ? "并删除最早记录" : ""
          }，当前${storageKey}数量: ${records.length}/${limit}`
        );
      } catch (error) {
        console.log(`存储管理出错: ${error.message}`);
      }
    }
 
    static getParsedItem(storageKey, defaultValue = []) {
      try {
        const data = this.getItem(storageKey);
        return data ? JSON.parse(data) : defaultValue;
      } catch (error) {
        Core.log(`解析存储记录出错: ${error.message}`);
        return defaultValue;
      }
    }
 
    static ensureStorageLimits() {
      const limitConfigs = [
        {
          key: CONFIG.STORAGE_KEYS.PROCESSED_HRS,
          set: state.hrInteractions.processedHRs,
          limit: CONFIG.STORAGE_LIMITS.PROCESSED_HRS,
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
          set: state.hrInteractions.sentGreetingsHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS,
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
          set: state.hrInteractions.sentResumeHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS,
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
          set: state.hrInteractions.sentImageResumeHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS,
        },
      ];
 
      limitConfigs.forEach(({ key, set, limit }) => {
        const records = this.getParsedItem(key, []);
        if (records.length > limit) {
          const trimmedRecords = records.slice(-limit);
          this.setItem(key, trimmedRecords);
 
          set.clear();
          trimmedRecords.forEach((record) => set.add(record));
 
          console.log(
            `存储管理: 清理${key}记录，从${records.length}减少到${trimmedRecords.length}`
          );
        }
      });
    }
  }
 
  class StatePersistence {
    static saveState() {
      try {
        // AI 回复计数/日期单独存（每日清零逻辑依赖它们）
        StorageManager.setItem("aiReplyCount", state.ai.replyCount);
        StorageManager.setItem("lastAiDate", state.ai.lastAiDate);

        // 其余配置统一由 SettingsStore 落盘，避免再出现"漏写某个键"
        if (typeof settings !== "undefined" && settings) {
          settings.includeKeywords = state.includeKeywords || [];
          settings.locationKeywords = state.locationKeywords || [];
          SettingsStore.save(settings);
        }
      } catch (error) {
        console.warn("[海投助手] 保存状态失败:", error);
      }
    }

    static loadState() {
      try {
        state.includeKeywords = StorageManager.getParsedItem("includeKeywords", []);
        state.locationKeywords = StorageManager.getParsedItem("locationKeywords", []);
        if (!Array.isArray(state.includeKeywords)) state.includeKeywords = [];
        if (!Array.isArray(state.locationKeywords)) {
          state.locationKeywords = StorageManager.getParsedItem(
            "excludeKeywords",
            []
          );
        }

        // 从新配置层恢复，保证与设置弹窗展示的一致
        if (typeof settings !== "undefined" && settings) {
          if (Array.isArray(settings.includeKeywords)) {
            state.includeKeywords = settings.includeKeywords;
          }
          if (Array.isArray(settings.locationKeywords)) {
            state.locationKeywords = settings.locationKeywords;
          }
          if (Array.isArray(settings.imageResumes)) {
            state.settings.imageResumes = settings.imageResumes;
          }
          if (Array.isArray(settings.greetingsList)) {
            state.settings.greetingsList = settings.greetingsList;
          }
        }

        StorageManager.ensureStorageLimits();
      } catch (error) {
        console.warn("[海投助手] 加载状态失败:", error);
      }
    }
  }
 
  class HRInteractionManager {
    /**
     * 处理HR交互
     * @param {string} hrKey - HR唯一标识
     * @returns {Promise<void>}
     */
    static async handleHRInteraction(hrKey) {
      const hasResponded = await this.hasHRResponded();
 
      if (!state.hrInteractions.sentGreetingsHRs.has(hrKey)) {
        await this._handleFirstInteraction(hrKey);
        return;
      }
 
      if (
        !state.hrInteractions.sentResumeHRs.has(hrKey) ||
        !state.hrInteractions.sentImageResumeHRs.has(hrKey)
      ) {
        if (hasResponded) {
          await this._handleFollowUpResponse(hrKey);
        }
        return;
      }
 
      await Core.aiReply();
    }
 
    static async _handleFirstInteraction(hrKey) {
      Core.log(`首次沟通: ${hrKey}`);
 
      const sentGreeting = await this.sendGreetings();
      if (sentGreeting) {
        StorageManager.addRecordWithLimit(
          CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
          hrKey,
          state.hrInteractions.sentGreetingsHRs,
          CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS
        );
      }
 
      await this._handleResumeSending(hrKey);
    }
 
    static async _handleResumeSending(hrKey) {
      if (
        state.settings.useAutoSendResume &&
        !state.hrInteractions.sentResumeHRs.has(hrKey)
      ) {
        const sentResume = await this.sendResume();
        if (sentResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
            hrKey,
            state.hrInteractions.sentResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS
          );
        }
      }
 
      if (
        state.settings.useAutoSendImageResume &&
        !state.hrInteractions.sentImageResumeHRs.has(hrKey)
      ) {
        const sentImageResume = await this.sendImageResume();
        if (sentImageResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
            hrKey,
            state.hrInteractions.sentImageResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS
          );
        }
      }
    }
 
    static async _handleFollowUpResponse(hrKey) {
      if (this.hasCardMessage()) {
        const handled = await this.handleCardMessage(hrKey);
        if (handled) {
          return;
        }
      }
 
      const lastMessage = await Core.getLastFriendMessageText();
 
      if (
        lastMessage &&
        (lastMessage.includes("简历") || lastMessage.includes("发送简历"))
      ) {
        Core.log(`HR提到"简历"，发送简历: ${hrKey}`);
 
        if (
          state.settings.useAutoSendImageResume &&
          !state.hrInteractions.sentImageResumeHRs.has(hrKey)
        ) {
          const sentImageResume = await this.sendImageResume();
          if (sentImageResume) {
            state.hrInteractions.sentImageResumeHRs.add(hrKey);
            StatePersistence.saveState();
            Core.log(`已向 ${hrKey} 发送图片简历`);
            return;
          }
        }
 
        if (!state.hrInteractions.sentResumeHRs.has(hrKey)) {
          const sentResume = await this.sendResume();
          if (sentResume) {
            state.hrInteractions.sentResumeHRs.add(hrKey);
            StatePersistence.saveState();
            Core.log(`已向 ${hrKey} 发送简历`);
          }
        }
      }
    }
 
    /**
     * 发送自定义回复
     * @param {string} replyText - 回复文本
     * @returns {Promise<boolean>} 是否发送成功
     */
    static async sendCustomReply(replyText) {
      try {
        const inputBox = await Core.waitForElement("#chat-input");
        if (!inputBox) {
          Core.log("未找到聊天输入框");
          return false;
        }
 
        inputBox.textContent = "";
        inputBox.focus();
        document.execCommand("insertText", false, replyText);
        await Core.delay(CONFIG.OPERATION_INTERVAL / 10);
 
        const sendButton = DOMCache.get(".btn-send");
        if (sendButton) {
          await Core.simulateClick(sendButton);
        } else {
          const enterKeyEvent = new KeyboardEvent("keydown", {
            key: "Enter",
            keyCode: 13,
            code: "Enter",
            which: 13,
            bubbles: true,
          });
          inputBox.dispatchEvent(enterKeyEvent);
        }
 
        return true;
      } catch (error) {
        ErrorHandler.handle(error, 'HRInteractionManager.sendCustomReply');
        Core.log(`发送自定义回复出错: ${error.message}`);
        return false;
      }
    }
 
    static async hasHRResponded() {
      await Core.delay(state.settings.actionDelays.click);
 
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) return false;
 
      const friendMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-friend")
      );
      return friendMessages.length > 0;
    }
 
    static hasCardMessage() {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) return false;
 
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) return false;
 
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const cardWrap = lastMessageEl.querySelector(".message-card-wrap");
        return cardWrap !== null;
      } catch (error) {
        Core.log(`检测卡片消息出错: ${error.message}`);
        return false;
      }
    }
 
    static async handleCardMessage(hrKey) {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) {
          Core.log("未找到聊天容器");
          return false;
        }
 
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) {
          Core.log("未找到HR消息");
          return false;
        }
 
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const cardButtons = lastMessageEl.querySelectorAll(".card-btn");
 
        if (!cardButtons || cardButtons.length === 0) {
          Core.log("未找到卡片按钮");
          return false;
        }
 
        for (const btn of cardButtons) {
          if (btn.textContent.trim() === "同意") {
            await Core.simulateClick(btn);
            await Core.delay(state.settings.actionDelays.click);
            return true;
          }
        }
 
        Core.log(`未找到"同意"按钮`);
        return false;
      } catch (error) {
        Core.log(`处理卡片消息出错: ${error.message}`);
        return false;
      }
    }
 
    static async sendGreetings() {
      try {
        if (
          !state.settings.greetingsList ||
          state.settings.greetingsList.length === 0
        ) {
          return false;
        }
 
        for (let i = 0; i < state.settings.greetingsList.length; i++) {
          const greeting = state.settings.greetingsList[i];
          if (!greeting.content || !greeting.content.trim()) {
            continue;
          }
          Core.log(
            `发送自我介绍：第${i + 1}条/共${state.settings.greetingsList.length}条`
          );
          await this.sendCustomReply(greeting.content);
          await Core.delay(state.settings.actionDelays.click);
        }
 
        return true;
      } catch (error) {
        Core.log(`发送自我介绍出错: ${error.message}`);
        return false;
      }
    }
 
    static _findMatchingResume(resumeItems, positionName) {
      try {
        const positionNameLower = positionName.toLowerCase();
        const twoCharKeywords = Core.extractTwoCharKeywords(positionNameLower);
 
        for (const keyword of twoCharKeywords) {
          for (const item of resumeItems) {
            const resumeNameElement = item.querySelector(".resume-name");
            if (!resumeNameElement) continue;
 
            const resumeName = resumeNameElement.textContent
              .trim()
              .toLowerCase();
 
            if (resumeName.includes(keyword)) {
              const resumeNameText = resumeNameElement.textContent.trim();
              Core.log(`智能匹配: "${resumeNameText}" 依据: "${keyword}"`);
              return item;
            }
          }
        }
 
        return null;
      } catch (error) {
        Core.log(`简历匹配出错: ${error.message}`);
        return null;
      }
    }
 
    static async sendResume() {
      try {
        const resumeBtn = await Core.waitForElement(() => {
          return [...document.querySelectorAll(".toolbar-btn")].find(
            (el) => el.textContent.trim() === "发简历"
          );
        });
 
        if (!resumeBtn) {
          Core.log("无法发送简历，未找到发简历按钮");
          return false;
        }
 
        if (resumeBtn.classList.contains("unable")) {
          Core.log("对方未回复，您无权发送简历");
          return false;
        }
 
        let positionName = Core.getPositionName();
        if (!positionName) {
          Core.log("未找到岗位名称元素");
        }
 
        await Core.simulateClick(resumeBtn);
        await Core.smartDelay(state.settings.actionDelays.click, "click");
        await Core.smartDelay(800, "resume_load");
 
        const confirmDialog = document.querySelector(
          ".panel-resume.sentence-popover"
        );
        if (confirmDialog) {
          Core.log("您只有一份附件简历");
 
          const confirmBtn = confirmDialog.querySelector(".btn-sure-v2");
          if (!confirmBtn) {
            Core.log("未找到确认按钮");
            return false;
          }
 
          await Core.simulateClick(confirmBtn);
          return true;
        }
 
        const resumeList = await Core.waitForElement("ul.resume-list");
        if (!resumeList) {
          Core.log("未找到简历列表");
          return false;
        }
 
        const resumeItems = Array.from(
          resumeList.querySelectorAll("li.list-item")
        );
        if (resumeItems.length === 0) {
          Core.log("未找到简历列表项");
          return false;
        }
 
        let selectedResumeItem = null;
        if (positionName) {
          selectedResumeItem = this._findMatchingResume(
            resumeItems,
            positionName
          );
        }
 
        if (!selectedResumeItem) {
          selectedResumeItem = resumeItems[0];
          const resumeName = selectedResumeItem
            .querySelector(".resume-name")
            .textContent.trim();
          Core.log('使用第一个简历: "' + resumeName + '"');
        }
 
        await Core.simulateClick(selectedResumeItem);
        await Core.smartDelay(state.settings.actionDelays.click, "click");
        await Core.smartDelay(500, "selection");
 
        const sendBtn = await Core.waitForElement(
          "button.btn-v2.btn-sure-v2.btn-confirm"
        );
        if (!sendBtn) {
          Core.log("未找到发送按钮");
          return false;
        }
 
        if (sendBtn.disabled) {
          Core.log("发送按钮不可用，可能简历未正确选择");
          return false;
        }
 
        await Core.simulateClick(sendBtn);
        return true;
      } catch (error) {
        Core.log(`发送简历出错: ${error.message}`);
        return false;
      }
    }
 
    static selectImageResume(positionName) {
      try {
        const positionNameLower = positionName.toLowerCase();
 
        if (state.settings.imageResumes.length === 1) {
          return state.settings.imageResumes[0];
        }
 
        const twoCharKeywords = Core.extractTwoCharKeywords(positionNameLower);
 
        for (const keyword of twoCharKeywords) {
          for (const resume of state.settings.imageResumes) {
            const resumeNameLower = resume.path.toLowerCase();
 
            if (resumeNameLower.includes(keyword)) {
              Core.log(`智能匹配: "${resume.path}" 依据: "${keyword}"`);
              return resume;
            }
          }
        }
 
        return state.settings.imageResumes[0];
      } catch (error) {
        Core.log(`选择图片简历出错: ${error.message}`);
        return state.settings.imageResumes[0] || null;
      }
    }
 
    static async sendImageResume() {
      try {
        if (
          !state.settings.useAutoSendImageResume ||
          !state.settings.imageResumes ||
          state.settings.imageResumes.length === 0
        ) {
          return false;
        }
 
        let positionName = Core.getPositionName();
        if (!positionName) {
          Core.log("未找到岗位名称元素");
        }
 
        const selectedResume = this.selectImageResume(positionName);
 
        if (!selectedResume || !selectedResume.data) {
          Core.log("没有可发送的图片简历数据");
          return false;
        }
 
        const imageSendBtn = await Core.waitForElement(
          '.toolbar-btn-content.icon.btn-sendimg input[type="file"]'
        );
        if (!imageSendBtn) {
          Core.log("未找到图片发送按钮");
          return false;
        }
 
        const byteCharacters = atob(selectedResume.data.split(",")[1]);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: "image/jpeg" });
 
        const file = new File([blob], selectedResume.path, {
          type: "image/jpeg",
          lastModified: new Date().getTime(),
        });
 
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
 
        imageSendBtn.files = dataTransfer.files;
 
        const event = new Event("change", { bubbles: true });
        imageSendBtn.dispatchEvent(event);
        return true;
      } catch (error) {
        Core.log(`发送图片出错: ${error.message}`);
        return false;
      }
    }
  }
 
  const UI = {
    PAGE_TYPES: {
      JOB_LIST: "jobList",
      CHAT: "chat",
    },
 
    currentPageType: null,
 
    init() {
      this.currentPageType = PAGE.isChat()
        ? this.PAGE_TYPES.CHAT
        : this.PAGE_TYPES.JOB_LIST;
      this._applyTheme();
      this.createControlPanel();
      this.createMiniIcon();
      this._restorePanelPosition();

      // 旧版这里调用了一个并不存在的 Core.loadAndDisplayComments()，
      // 每次进入职位页都会抛 TypeError。评论区功能已下线，这里直接移除。
      this._bindJobCardClick();
    },

    /**
     * v2.1.0：点击职位卡片 → 生成 AI 招呼语。
     * 旧版只绑定一次 document 监听（重复 init 会叠加），且要求 settings.resume 有值，
     * 而 resume 又被"保存设置"清空过，导致这个功能实际从不触发。
     */
    _bindJobCardClick() {
      if (this._cardClickBound) return;
      this._cardClickBound = true;

      document.addEventListener(
        "click",
        function (e) {
          try {
            if (!settings.aiGreetingEnabled) return;
            if (state.isRunning) return;

            const target = e.target;
            const card =
              (target.closest && target.closest("li.job-card-box")) ||
              (target.closest && target.closest(".job-card-wrapper")) ||
              (target.closest && target.closest('.job-list-box li[data-jobid]'));
            if (!card) return;
            // 点击"立即沟通"等按钮时不触发 AI 生成，交给投递流程
            if (target.closest && target.closest(".op-btn-chat, .btn-startchat"))
              return;

            const jobId = Core.getCardJobId(card);
            if (!jobId) return;

            // 记录当前选中的职位，供"一键投递"使用
            state.currentJobKey = jobId;
            const nameEl = card.querySelector(".job-name");
            state.currentJobTitle = nameEl ? nameEl.textContent.trim() : "";

            if (!settings.aiApiKey) {
              Core.log("提示：尚未配置 AI API Key，可在设置中配置后生成个性化招呼语");
              return;
            }
            if (!settings.resume || !settings.resume.trim()) {
              Core.log("提示：尚未填写「个人简历」，AI 无法生成招呼语（设置 → AI 设置）");
              return;
            }

            clearTimeout(UI._aiGenTimer);
            UI._aiGenTimer = setTimeout(async function () {
              try {
                const info = Core.extractJobDetail();
                if (info && info.title) {
                  await Core.generateGreeting(info);
                  const ps = document.getElementById("greeting-preview-section");
                  if (ps) ps.style.display = "block";
                }
              } catch (err) {
                console.error("[海投助手] 生成招呼语失败:", err);
              }
            }, 1200);
          } catch (err) {
            console.error("[海投助手] 卡片点击处理异常:", err);
          }
        },
        true
      );
    },

    /** 恢复面板上次的拖拽位置 */
    _restorePanelPosition() {
      try {
        const pos = settings.panelPosition;
        if (pos && elements.panel && typeof pos.left === "number") {
          elements.panel.style.right = "auto";
          elements.panel.style.top = pos.top + "px";
          elements.panel.style.left = pos.left + "px";
        }
      } catch (e) {}
    },

    /** 旧版调用了未定义的 UI.notify，这里补上（对应"招呼语开关检测"提示） */
    notify(message, type) {
      if (typeof showNotification === "function") {
        showNotification(message, type === "warning" ? "error" : type || "success");
      } else {
        console.log("[海投助手]", message);
      }
    },

    createControlPanel() {
      if (document.getElementById("boss-pro-panel")) {
        document.getElementById("boss-pro-panel").remove();
      }
 
      elements.panel = this._createPanel();
 
      const header = this._createHeader();
      const controls = this._createPageControls();
      elements.log = this._createLogger();
      const footer = this._createFooter();
 
      elements.panel.append(header, controls, elements.log, footer);
      document.body.appendChild(elements.panel);
      this._makeDraggable(elements.panel);

      // 面板挂到 document 之后，统一同步一次与模式相关的 UI
      // （旧版在元素还游离在内存里时就调用，导致取不到节点、开关状态永远不刷新）
      refreshPanelModeUI();
      refreshStatsUI();
      if (this.currentPageType === this.PAGE_TYPES.JOB_LIST) {
        loadSettingsIntoUIFilters();
      }
    },
 
    _applyTheme() {
      CONFIG.COLORS =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? this.THEMES.JOB_LIST
          : this.THEMES.CHAT;
 
      document.documentElement.style.setProperty(
        "--primary-color",
        CONFIG.COLORS.primary
      );
      document.documentElement.style.setProperty(
        "--secondary-color",
        CONFIG.COLORS.secondary
      );
      document.documentElement.style.setProperty(
        "--accent-color",
        CONFIG.COLORS.accent
      );
      document.documentElement.style.setProperty(
        "--neutral-color",
        CONFIG.COLORS.neutral
      );
    },
 
    THEMES: {
      JOB_LIST: {
        primary: "#4F46E5",
        secondary: "#f5f7fa",
        accent: "#e8f0fe",
        neutral: "#6b7280",
      },
      CHAT: {
        primary: "#34a853",
        secondary: "#f0fdf4",
        accent: "#dcfce7",
        neutral: "#6b7280",
      },
    },
 
    _createPanel() {
      const panel = document.createElement("div");
      panel.id = "boss-pro-panel";
      panel.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-panel"
          : "boss-chat-panel";
 
      const baseStyles = `
            position: fixed;
            top: 36px;
            right: 24px;
            width: clamp(300px, 80vw, 400px);
            border-radius: 12px;
            padding: 12px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            transition: all 0.3s ease;
            background: #ffffff;
            box-shadow: 0 10px 25px rgba(var(--primary-rgb), 0.15);
            border: 1px solid var(--accent-color);
            cursor: default;
        `;
 
      panel.style.cssText = baseStyles;
 
      const rgbColor = this._hexToRgb(CONFIG.COLORS.primary);
      document.documentElement.style.setProperty("--primary-rgb", rgbColor);
 
      return panel;
    },
 
    _createHeader() {
      const header = document.createElement("div");
      header.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-header"
          : "boss-chat-header";
 
      header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 10px 15px;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--accent-color);
        `;
 
      const title = this._createTitle();
 
      const buttonContainer = document.createElement("div");
      buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
        `;
 
      const buttonTitles =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? {
            activate: "激活插件",
            settings: "插件设置",
            close: "最小化海投面板",
          }
          : {
            activate: "激活插件",
            settings: "海投设置",
            close: "最小化聊天面板",
          };
 
      var settingsBtn = this._createIconButton(
        "⚙",
        function () {
          try {
            showSettingsDialog();
          } catch (e) {
            console.error("[海投助手] 打开设置失败:", e);
            if (typeof showNotification === "function") {
              showNotification("打开设置失败：" + e.message, "error");
            }
          }
        },
        buttonTitles.settings
      );
      var closeBtn = this._createIconButton(
        "✕",
        function () {
          state.isMinimized = true;
          elements.panel.style.transform = "translateY(160%)";
          if (elements.miniIcon) elements.miniIcon.style.display = "flex";
        },
        buttonTitles.close
      );
      buttonContainer.append(settingsBtn,closeBtn);
      header.append(title, buttonContainer);
      return header;
    },
 
    _createTitle() {
      const title = document.createElement("div");
      title.style.display = "flex";
      title.style.alignItems = "center";
      title.style.gap = "10px";
 
      const customSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" style="width:100%;height:100%;"><rect width="80" height="80" rx="14" fill="#4F46E5"/><g fill="white"><rect x="25" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="15" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="15" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="60" width="4.7" height="4.7" rx="0.5"/></g></svg>
    `;
 
      const titleConfig =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? {
            main: `<span style="color:var(--primary-color);">BOSS</span>海投助手`,
            sub: "AI智能 · 半自动投递",
          }
          : {
            main: `<span style="color:var(--primary-color);">BOSS</span>智能聊天`,
            sub: "智能对话 · 高效沟通",
          };
 
      title.innerHTML = `
        <div style="
            width: 40px;
            height: 40px;
            background: var(--primary-color);
            border-radius: 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            font-weight: bold;
            box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);
        ">
            ${customSvg}
        </div>
        <div>
            <h3 style="
                margin: 0;
                color: #2c3e50;
                font-weight: 600;
                font-size: 1.2rem;
            ">
                ${titleConfig.main}
            </h3>
            <span style="
                font-size:0.8em;
                color:var(--neutral-color);
            ">
                ${titleConfig.sub}
            </span>
        </div>
    `;
 
      return title;
    },
 
    _createPageControls() {
      if (this.currentPageType === this.PAGE_TYPES.JOB_LIST) {
        return this._createJobListControls();
      } else {
        return this._createChatControls();
      }
    },
 
    _createJobListControls() {
      const container = document.createElement("div");
      container.className = "boss-joblist-controls";
      container.style.marginBottom = "15px";
      container.style.padding = "0 10px";
 
      const filterContainer = this._createFilterContainer();
 
      container.append(filterContainer);
      return container;
    },
 
    _createChatControls() {
      const container = document.createElement("div");
      container.className = "boss-chat-controls";
      container.style.cssText = `
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 15px;
            margin-left: 10px;
            margin-right: 10px;
            margin-bottom: 15px;
        `;
 
      const configRow = document.createElement("div");
      configRow.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
        `;
 
      const communicationIncludeCol = this._createInputControl(
        "沟通岗位包含：",
        "communication-include",
        "如：技术,产品,设计"
      );
 
      const communicationModeCol = this._createSelectControl(
        "沟通模式：",
        "communication-mode-selector",
        [
          { value: "new-only", text: "仅新消息" },
          { value: "auto", text: "自动轮询" },
        ]
      );
 
      elements.communicationIncludeInput =
        communicationIncludeCol.querySelector("input");
      elements.communicationModeSelector =
        communicationModeCol.querySelector("select");
      configRow.append(communicationIncludeCol, communicationModeCol);
 
      elements.communicationModeSelector.addEventListener("change", (e) => {
        settings.communicationMode = e.target.value;
        saveSettings();
      });
 
      elements.communicationIncludeInput.addEventListener("input", (e) => {
        settings.communicationIncludeKeywords = e.target.value;
        saveSettings();
      });
 
      elements.controlBtn = this._createTextButton(
        "开始智能聊天",
        "var(--primary-color)",
        () => {
          toggleChatProcess();
        }
      );
 
      container.append(configRow, elements.controlBtn);
      return container;
    },
 
    _createFilterContainer() {
      const filterContainer = document.createElement("div");
      filterContainer.style.cssText = `
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 15px;
            margin-bottom: 0px;
        `;
 
      const filterRow = document.createElement("div");
      filterRow.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 12px;
        `;
 
      const includeFilterCol = this._createInputControl(
        "职位名包含：",
        "include-filter",
        "如：前端，开发"
      );
      const locationFilterCol = this._createInputControl(
        "工作地包含：",
        "location-filter",
        "如：杭州，滨江"
      );
 
      elements.includeInput = includeFilterCol.querySelector("input");
      elements.locationInput = locationFilterCol.querySelector("input");
 
      filterRow.append(includeFilterCol, locationFilterCol);
 
      var aiRow=document.createElement("div");aiRow.style.cssText="display:flex;justify-content:space-between;align-items:center;padding:8px 0;margin-bottom:8px;";
      aiRow.innerHTML='<div style="display:flex;flex-direction:column;gap:2px;"><span style="font-size:13px;font-weight:600;color:#1e293b;">🤖 AI智能招呼语</span><span id="ai-greeting-mode-hint" style="font-size:11px;color:#4F46E5;">半自动：AI 生成招呼语，确认后投递</span></div>';
      var aiSw=document.createElement("div");aiSw.id="ai-greeting-toggle";aiSw.title="开启：半自动（AI生成招呼语，确认后投递）｜关闭：全自动批量海投";aiSw.style.cssText="position:relative;width:48px;height:26px;border-radius:13px;cursor:pointer;transition:background 0.3s;";
      var aiTh=document.createElement("div");aiTh.id="ai-greeting-thumb";aiTh.style.cssText="position:absolute;top:3px;width:20px;height:20px;border-radius:50%;background:white;box-shadow:0 1px 3px rgba(0,0,0,0.2);transition:left 0.3s;";
      aiSw.appendChild(aiTh);aiRow.appendChild(aiSw);
      // 注意：此处 aiSw 还没挂到 document 上，不能靠 getElementById 取，
      // 必须直接用局部变量同步视觉状态（旧版就是因为这个原因，开关永远是灰的）
      (function applyLocalState(){
        var on=!!settings.aiGreetingEnabled;
        aiSw.style.background=on?"#4F46E5":"#cbd5e1";
        aiTh.style.left=on?"25px":"3px";
      })();
      aiSw.addEventListener("click",function(){
        settings.aiGreetingEnabled=!settings.aiGreetingEnabled;
        saveSettings();
        refreshPanelModeUI(true);
        Core.log(settings.aiGreetingEnabled?"已切换为 AI 半自动模式：点击职位卡片生成招呼语":"已切换为全自动模式：点「启动海投」批量沟通");
      });
      filterContainer.appendChild(aiRow);
      var gp=document.createElement("div");gp.id="greeting-preview-section";gp.style.cssText="background:var(--secondary-color);border-radius:12px;padding:12px;margin-bottom:12px;";
      gp.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:600;font-size:13px;color:#333;">📝 AI招呼语预览 (可编辑)</span><button id="regen-greeting-btn" style="padding:4px 10px;background:var(--primary-color);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:11px;">重新生成</button></div>';
      var gta=document.createElement("textarea");gta.id="greeting-preview-text";gta.rows=5;gta.placeholder="点击左侧职位卡片后，AI 会自动生成针对性招呼语…";
      gta.style.cssText="width:100%;padding:10px;border-radius:8px;border:1px solid #d1d5db;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;";
      gp.appendChild(gta);filterContainer.appendChild(gp);
      // 同样：预览区此刻还没挂载，直接先设一次显示状态
      gp.style.display = settings.aiGreetingEnabled ? "block" : "none";
      var rb=document.getElementById("regen-greeting-btn");
      if(rb)rb.addEventListener("click",async function(){
        var ji=Core.extractJobDetail?Core.extractJobDetail():null;
        if(ji&&ji.title){await Core.generateGreeting(ji);}
        else{
          var card=Core.getSelectedCard&&Core.getSelectedCard();
          if(card){var t=card.querySelector(".job-name");await Core.generateGreeting({title:(t&&t.textContent.trim())||"",description:""});}
          else Core.log("请先点击一个职位卡片");
        }
      });

      elements.controlBtn = this._createTextButton(
        settings.aiGreetingEnabled?"🚀 一键投递":"▶ 启动海投",
        "var(--primary-color)",
        () => {
          toggleProcess();
        }
      );
 
      filterContainer.append(filterRow, elements.controlBtn);
      return filterContainer;
    },
 
    _createInputControl(labelText, id, placeholder) {
      const controlCol = document.createElement("div");
      controlCol.style.cssText = "flex: 1;";
 
      const label = document.createElement("label");
      label.textContent = labelText;
      label.style.cssText =
        "display:block; margin-bottom:5px; font-weight: 500; color: #333; font-size: 0.9rem;";
 
      const input = document.createElement("input");
      input.id = id;
      input.placeholder = placeholder;
      input.style.cssText = `
            width: 100%;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid #d1d5db;
            font-size: 14px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            transition: all 0.2s ease;
        `;
 
      controlCol.append(label, input);
      return controlCol;
    },
 
    _createSelectControl(labelText, id, options) {
      const controlCol = document.createElement("div");
      controlCol.style.cssText = "flex: 1;";
 
      const label = document.createElement("label");
      label.textContent = labelText;
      label.style.cssText =
        "display:block; margin-bottom:5px; font-weight: 500; color: #333; font-size: 0.9rem;";
 
      const select = document.createElement("select");
      select.id = id;
      select.style.cssText = `
            width: 100%;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid #d1d5db;
            font-size: 14px;
            background: white;
            color: #333;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            transition: all 0.2s ease;
        `;
 
      options.forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.text;
        select.appendChild(opt);
      });
 
      controlCol.append(label, select);
      return controlCol;
    },
 
    _createLogger() {
      const log = document.createElement("div");
      log.id = "pro-log";
      log.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-log"
          : "boss-chat-log";
 
      const height =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "260px" : "260px";
 
      log.style.cssText = `
            height: ${height};
            overflow-y: auto;
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 12px;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 15px;
            margin-left: 10px;
            margin-right: 10px;
            transition: all 0.3s ease;
            user-select: text;
            scrollbar-width: thin;
            scrollbar-color: var(--primary-color) var(--secondary-color);
        `;
 
      log.innerHTML += `
            <style>
                #pro-log::-webkit-scrollbar {
                    width: 6px;
                }
                #pro-log::-webkit-scrollbar-track {
                    background: var(--secondary-color);
                    border-radius: 4px;
                }
                #pro-log::-webkit-scrollbar-thumb {
                    background-color: var(--primary-color);
                    border-radius: 4px;
                }
            </style>
        `;
 
      return log;
    },
 
    _createFooter() {
      const footer = document.createElement("div");
      footer.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-footer"
          : "boss-chat-footer";
 
      footer.style.cssText = `
            text-align: center;
            font-size: 0.8em;
            color: var(--neutral-color);
            padding-top: 15px;
            border-top: 1px solid var(--accent-color);
            margin-top: auto;
            padding: 0px;
        `;
 
      const statsContainer = document.createElement("div");
      statsContainer.id = "boss-panel-stats";
      statsContainer.style.cssText = `
            display: flex;
            justify-content: space-around;
            margin-bottom: 15px;
            gap: 6px;
        `;

      statsContainer.innerHTML = `
        <div style="flex:1;text-align:center;"><div id="stat-greeted" style="font-size:16px;font-weight:600;color:#4F46E5;">0</div><div style="font-size:11px;color:#94a3b8;">已沟通</div></div>
        <div style="flex:1;text-align:center;"><div id="stat-resumed" style="font-size:16px;font-weight:600;color:#4F46E5;">0</div><div style="font-size:11px;color:#94a3b8;">已发简历</div></div>
        <div style="flex:1;text-align:center;"><div id="stat-skipped" style="font-size:16px;font-weight:600;color:#94a3b8;">0</div><div style="font-size:11px;color:#94a3b8;">已跳过</div></div>
        <div style="flex:1;text-align:center;"><div id="stat-failed" style="font-size:16px;font-weight:600;color:#ef4444;">0</div><div style="font-size:11px;color:#94a3b8;">失败</div></div>
      `;

      footer.append(
        statsContainer,
        document.createTextNode(`© ${new Date().getFullYear()} Zion Cai · All Rights Reserved`)
      );
      return footer;
    },

    _createTextButton(text, bgColor, onClick) {
      const btn = document.createElement("button");
      btn.className = "boss-btn";
      btn.textContent = text;
      btn.style.cssText = `
            width: 100%;
            padding: 10px 16px;
            background: ${bgColor};
            color: #fff;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            transition: all 0.3s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            transform: translateY(0px);
            margin: 0 auto;
        `;
 
      this._addButtonHoverEffects(btn);
      btn.addEventListener("click", onClick);
 
      return btn;
    },
 
    _createIconButton(icon,onClick,title){
      const btn=document.createElement("button");btn.className="boss-icon-btn";btn.innerHTML=icon;btn.title=title;
      btn.style.cssText="width:32px;height:32px;border-radius:50%;border:none;background:var(--accent-color);cursor:pointer;font-size:16px;display:flex;justify-content:center;align-items:center;color:var(--primary-color);overflow:hidden;";
      if(icon.includes("<svg"))btn.style.padding="4px";
      btn.addEventListener("click",onClick);
      var osf=null;if(icon.includes("<svg")){var s1=btn.querySelector("svg");if(s1){var p1=s1.querySelector("path");if(p1)osf=p1.getAttribute("fill")}}
      btn.addEventListener("mouseenter",function(){btn.style.backgroundColor="var(--primary-color)";btn.style.color="#fff";btn.style.transform="scale(1.1)";if(icon.includes("<svg")){var s2=btn.querySelector("svg");if(s2){var p2=s2.querySelector("path");if(p2)p2.setAttribute("fill","#fff")}}});
      btn.addEventListener("mouseleave",function(){btn.style.backgroundColor="var(--accent-color)";btn.style.color="var(--primary-color)";btn.style.transform="scale(1)";if(icon.includes("<svg")&&osf){var s3=btn.querySelector("svg");if(s3){var p3=s3.querySelector("path");if(p3)p3.setAttribute("fill",osf)}}});
      return btn;
    },

    _addButtonHoverEffects(btn) {
      btn.addEventListener("mouseenter", () => {
        btn.style.boxShadow = `0 6px 15px rgba(var(--primary-rgb), 0.3)`;
      });
 
      btn.addEventListener("mouseleave", () => {
        btn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.1)";
      });
    },
 
    _makeDraggable(panel) {
      const header = panel.querySelector(".boss-header, .boss-chat-header");
 
      if (!header) return;
 
      header.style.cursor = "move";
 
      let isDragging = false;
      let startX = 0,
        startY = 0;
      let initialX = panel.offsetLeft,
        initialY = panel.offsetTop;
 
      header.addEventListener("mousedown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialX = panel.offsetLeft;
        initialY = panel.offsetTop;
        panel.style.transition = "none";
        panel.style.zIndex = "2147483647";
      });
 
      document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
 
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
 
        panel.style.left = `${initialX + dx}px`;
        panel.style.top = `${initialY + dy}px`;
        panel.style.right = "auto";
      });
 
      document.addEventListener("mouseup", () => {
        if (isDragging) {
          isDragging = false;
          panel.style.transition = "all 0.3s ease";
          panel.style.zIndex = "2147483646";
          // 记住面板位置，刷新后不再回到默认点
          try {
            settings.panelPosition = {
              left: panel.offsetLeft,
              top: panel.offsetTop,
            };
            debouncedSaveSettings();
          } catch (e) {}
        }
      });
    },
 
    createMiniIcon() {
      const oldMini = document.getElementById("boss-mini-icon");
      if (oldMini) oldMini.remove();

      elements.miniIcon = document.createElement("div");
      elements.miniIcon.id = "boss-mini-icon";
      elements.miniIcon.title = "展开 BOSS 海投助手";
      elements.miniIcon.style.cssText = `
        width: ${CONFIG.MINI_ICON_SIZE || 48}px;
        height: ${CONFIG.MINI_ICON_SIZE || 48}px;
        position: fixed;
        bottom: 40px;
        left: 40px;
        background: var(--primary-color);
        border-radius: 50%;
        box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.4);
        cursor: pointer;
        display: none;
        justify-content: center;
        align-items: center;
        color: #fff;
        z-index: 2147483647;
        transition: all 0.3s ease;
        overflow: hidden;
 
    `;
 
      const customSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" style="width:100%;height:100%;"><rect width="80" height="80" rx="14" fill="#4F46E5"/><g fill="white"><rect x="25" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="5" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="10" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="15" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="15" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="20" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="25" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="30" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="35" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="40" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="30" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="45" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="45" width="4.7" height="4.7" rx="0.5"/><rect x="25" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="50" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="50" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="20" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="55" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="55" width="4.7" height="4.7" rx="0.5"/><rect x="10" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="15" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="35" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="40" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="60" y="60" width="4.7" height="4.7" rx="0.5"/><rect x="65" y="60" width="4.7" height="4.7" rx="0.5"/></g></svg>
    `;
 
      elements.miniIcon.innerHTML = customSvg;
 
      elements.miniIcon.addEventListener("mouseenter", () => {
        elements.miniIcon.style.transform = "scale(1.1)";
        elements.miniIcon.style.boxShadow = `0 8px 20px rgba(var(--primary-rgb), 0.5)`;
      });
 
      elements.miniIcon.addEventListener("mouseleave", () => {
        elements.miniIcon.style.transform = "scale(1)";
        elements.miniIcon.style.boxShadow = `0 6px 16px rgba(var(--primary-rgb), 0.4)`;
      });
 
      elements.miniIcon.addEventListener("click", () => {
        state.isMinimized = false;
        elements.panel.style.transform = "translateY(0)";
        elements.miniIcon.style.display = "none";
      });
 
      document.body.appendChild(elements.miniIcon);
    },
 
    _hexToRgb(hex) {
      hex = hex.replace("#", "");
 
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
 
      return `${r}, ${g}, ${b}`;
    },
  };
 
  /* =========================================================================
   * 统一配置层 —— v2.1.0 修复点（对应反馈："网页刷新设置里面配置信息全消失了"）
   *
   * 旧版问题：
   *   1) 存在两个互不同步的配置对象：state.settings 与全局 settings；
   *   2) saveSettings() 只持久化了一部分键（遗漏 aiGreetingEnabled、
   *      communicationMode、includeKeywords 等）；
   *   3) 全局 settings 初始化时根本没有读取 aiApiUrl/aiApiKey/aiModel/
   *      userResume/greetingTemplate，而 loadSettingsIntoUI 也没有回填这些输入框，
   *      于是用户打开设置弹窗 → 看到空输入框 → 点"保存设置" → 用空值覆盖了
   *      本地已保存的配置 → 刷新后配置全部消失。
   *
   * 现在：单一对象、单一键表、读全写全，并兼容旧键（excludeKeywords 等）。
   * ========================================================================= */

  const DEFAULT_AI_ROLE =
    "你是求职的应届生正在面对HR，回复需满足：20字内，编造专业对口/实习经验/证书任一岗位优势；被问个人信息或岗位条件，直接配合提供合理数据；全程积极真诚无拒绝言辞。";

  const SETTINGS_DEFAULTS = {
    // —— 运行模式 ——
    aiGreetingEnabled: true,        // AI 智能招呼语（半自动）；关闭 = 全自动海投
    autoReply: false,               // 聊天页 AI 自动回复
    useAutoSendResume: false,       // 自动发送附件简历
    useAutoSendImageResume: false,  // 自动发送图片简历
    excludeHeadhunters: false,      // 排除猎头
    useApiApply: false,             // 尝试走站内接口投递（更快，但易随接口变动失效）

    // —— 筛选 ——
    includeKeywords: [],            // 职位名包含
    locationKeywords: [],           // 工作地包含
    recruiterActivityStatus: ["不限"],

    // —— 聊天页 ——
    communicationMode: "new-only",
    communicationIncludeKeywords: "",

    // —— 节奏与安全上限 ——
    clickDelay: 130,
    applyInterval: 2500,
    maxApplyPerRun: 50,

    // —— 界面 ——
    theme: "light",
    panelPosition: null,
    letterShownVersion: "",

    // —— AI ——
    aiRole: DEFAULT_AI_ROLE,
    aiApiUrl: "https://api.deepseek.com/v1/chat/completions",
    aiApiKey: "",
    aiModel: "deepseek-chat",
    resume: "",
    greetingTemplate: "",
    greetingsList: [
      { id: "1", content: "" },
    ],

    // —— 图片简历 ——
    imageResumes: [],
    imageResumeData: null,
  };

  const SettingsStore = {
    /** 布尔值安全解析（兼容 "true" / true / "1"） */
    readBool(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        if (raw === "true" || raw === "1") return true;
        if (raw === "false" || raw === "0") return false;
        return !!JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },

    readJSON(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        const v = JSON.parse(raw);
        return v === null || v === undefined ? def : v;
      } catch (e) {
        return def;
      }
    },

    readString(key, def) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? def : raw;
      } catch (e) {
        return def;
      }
    },

    readNumber(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        const n = parseInt(raw, 10);
        return isNaN(n) ? def : n;
      } catch (e) {
        return def;
      }
    },

    /** 读取全部配置（含旧键迁移） */
    load() {
      const D = SETTINGS_DEFAULTS;

      // 旧键迁移：excludeKeywords -> locationKeywords
      let locationKeywords = this.readJSON("locationKeywords", null);
      if (!Array.isArray(locationKeywords)) {
        locationKeywords = this.readJSON("excludeKeywords", D.locationKeywords);
      }
      if (!Array.isArray(locationKeywords)) locationKeywords = [];

      let greetingsList = this.readJSON("greetingsList", null);
      if (!Array.isArray(greetingsList) || greetingsList.length === 0) {
        greetingsList = JSON.parse(JSON.stringify(D.greetingsList));
      }
      greetingsList = greetingsList
        .filter((g) => g && typeof g === "object")
        .map((g, i) => ({
          id: String(g.id || i + 1),
          content: typeof g.content === "string" ? g.content : "",
        }));

      let imageResumes = this.readJSON("imageResumes", []);
      if (!Array.isArray(imageResumes)) imageResumes = [];

      let activityStatus = this.readJSON(
        "recruiterActivityStatus",
        D.recruiterActivityStatus
      );
      if (!Array.isArray(activityStatus) || activityStatus.length === 0) {
        activityStatus = ["不限"];
      }

      return {
        aiGreetingEnabled: this.readBool("aiGreetingEnabled", D.aiGreetingEnabled),
        autoReply: this.readBool("autoReply", D.autoReply),
        useAutoSendResume: this.readBool("useAutoSendResume", D.useAutoSendResume),
        useAutoSendImageResume: this.readBool(
          "useAutoSendImageResume",
          D.useAutoSendImageResume
        ),
        excludeHeadhunters: this.readBool("excludeHeadhunters", D.excludeHeadhunters),
        useApiApply: this.readBool("useApiApply", D.useApiApply),

        includeKeywords: (() => {
          const v = this.readJSON("includeKeywords", []);
          return Array.isArray(v) ? v : [];
        })(),
        locationKeywords,
        recruiterActivityStatus: activityStatus,

        communicationMode: this.readString("communicationMode", D.communicationMode),
        communicationIncludeKeywords: this.readString(
          "communicationIncludeKeywords",
          D.communicationIncludeKeywords
        ),

        clickDelay: this.readNumber("clickDelay", D.clickDelay),
        applyInterval: this.readNumber("applyInterval", D.applyInterval),
        maxApplyPerRun: this.readNumber("maxApplyPerRun", D.maxApplyPerRun),

        theme: this.readString("theme", D.theme),
        panelPosition: this.readJSON("panelPosition", null),
        letterShownVersion: this.readString("letterShownVersion", ""),

        aiRole: this.readString("aiRole", D.aiRole),
        aiApiUrl: this.readString("aiApiUrl", D.aiApiUrl),
        aiApiKey: this.readString("aiApiKey", D.aiApiKey),
        aiModel: this.readString("aiModel", D.aiModel),
        resume: this.readString("userResume", D.resume),
        greetingTemplate: this.readString("greetingTemplate", D.greetingTemplate),
        greetingsList,

        imageResumes,
        imageResumeData: this.readString("imageResumeData", null),
      };
    },

    /** 写入全部配置 */
    save(s) {
      if (!s) return;
      const write = (k, v) => {
        try {
          localStorage.setItem(k, v === null || v === undefined ? "" : String(v));
        } catch (e) {
          console.warn("[海投助手] 写入配置失败", k, e);
        }
      };
      const writeJSON = (k, v) => {
        try {
          localStorage.setItem(k, JSON.stringify(v));
        } catch (e) {
          console.warn("[海投助手] 写入配置失败", k, e);
        }
      };

      write("aiGreetingEnabled", s.aiGreetingEnabled);
      write("autoReply", s.autoReply);
      write("useAutoSendResume", s.useAutoSendResume);
      write("useAutoSendImageResume", s.useAutoSendImageResume);
      write("excludeHeadhunters", s.excludeHeadhunters);
      write("useApiApply", s.useApiApply);

      writeJSON("includeKeywords", s.includeKeywords || []);
      writeJSON("locationKeywords", s.locationKeywords || []);
      writeJSON("recruiterActivityStatus", s.recruiterActivityStatus || ["不限"]);

      write("communicationMode", s.communicationMode);
      write("communicationIncludeKeywords", s.communicationIncludeKeywords);

      write("clickDelay", s.clickDelay);
      write("applyInterval", s.applyInterval);
      write("maxApplyPerRun", s.maxApplyPerRun);

      write("theme", s.theme);
      writeJSON("panelPosition", s.panelPosition);
      write("letterShownVersion", s.letterShownVersion);

      write("aiRole", s.aiRole);
      write("aiApiUrl", s.aiApiUrl);
      write("aiApiKey", s.aiApiKey);
      write("aiModel", s.aiModel);
      write("userResume", s.resume);
      write("greetingTemplate", s.greetingTemplate);
      writeJSON("greetingsList", s.greetingsList || []);

      writeJSON("imageResumes", s.imageResumes || []);
      if (s.imageResumeData) write("imageResumeData", s.imageResumeData);
      else {
        try {
          localStorage.removeItem("imageResumeData");
        } catch (e) {}
      }
    },
  };

  /** 唯一配置实例；state.settings 会指向同一个对象（见下方 state.settings = settings） */
  const settings = SettingsStore.load();

  // 兼容旧代码写法 settings.ai.role / settings.ai.apiKey / settings.actionDelays.click
  Object.defineProperty(settings, "ai", {
    enumerable: false,
    configurable: true,
    get() {
      const self = settings;
      return {
        get role() {
          return self.aiRole;
        },
        set role(v) {
          self.aiRole = v;
        },
        get apiUrl() {
          return self.aiApiUrl;
        },
        set apiUrl(v) {
          self.aiApiUrl = v;
        },
        get apiKey() {
          return self.aiApiKey;
        },
        set apiKey(v) {
          self.aiApiKey = v;
        },
        get model() {
          return self.aiModel;
        },
        set model(v) {
          self.aiModel = v;
        },
      };
    },
  });

  Object.defineProperty(settings, "actionDelays", {
    enumerable: false,
    configurable: true,
    get() {
      const self = settings;
      return {
        get click() {
          return self.clickDelay;
        },
        set click(v) {
          self.clickDelay = v;
        },
      };
    },
  });

  // 关键：让 state.settings 与全局 settings 变成同一个对象，彻底消除"两份配置不同步"
  state.settings = settings;

  /** 兼容旧调用点：保存配置并同步到 state */
  function saveSettings() {
    try {
      SettingsStore.save(settings);
      if (state && state.settings) Object.assign(state.settings, settings);
      return true;
    } catch (error) {
      console.error("[海投助手] 保存设置失败:", error);
      return false;
    }
  }
 
  function createSettingsDialog() {
    const dialog = document.createElement("div");
    dialog.id = "boss-settings-dialog";
    dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(300px, 90vw, 550px);
        height: 80vh;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.15);
        z-index: 999999;
        display: none;
        flex-direction: column;
        font-family: 'Segoe UI', sans-serif;
        overflow: hidden;
        transition: all 0.3s ease;
    `;
 
    dialog.innerHTML += `
        <style>
            #boss-settings-dialog {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
            }
            #boss-settings-dialog.active {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            .setting-item {
                transition: all 0.2s ease;
            }
            .setting-item:hover {
                background-color: rgba(0, 123, 255, 0.05);
            }
            .multi-select-container {
                position: relative;
                width: 100%;
                margin-top: 10px;
            }
            .multi-select-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-header:hover {
                border-color: rgba(0, 123, 255, 0.7);
            }
            .multi-select-options {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                max-height: 200px;
                overflow-y: auto;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                z-index: 100;
                box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                display: none;
            }
            .multi-select-option {
                padding: 10px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-option:hover {
                background-color: rgba(0, 123, 255, 0.05);
            }
            .multi-select-option.selected {
                background-color: rgba(0, 123, 255, 0.1);
            }
            .multi-select-clear {
                color: #666;
                cursor: pointer;
                margin-left: 5px;
            }
            .multi-select-clear:hover {
                color: #333;
            }
        </style>
    `;
 
    const dialogHeader = createDialogHeader("海投助手-设置");
 
    const dialogContent = document.createElement("div");
    dialogContent.style.cssText = `
        padding: 18px;
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 123, 255, 0.5) rgba(0, 0, 0, 0.05);
    `;
 
    dialogContent.innerHTML += `
    <style>
        #boss-settings-dialog ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        #boss-settings-dialog ::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.05);
            border-radius: 10px;
            margin: 8px 0;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb {
            background: rgba(0, 123, 255, 0.5);
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb:hover {
            background: rgba(0, 123, 255, 0.7);
            box-shadow: 0 1px 5px rgba(0,0,0,0.15);
        }
    </style>
    `;
 
    const tabsContainer = document.createElement("div");
    tabsContainer.style.cssText = `
        display: flex;
        border-bottom: 1px solid rgba(0, 123, 255, 0.2);
        margin-bottom: 20px;
    `;
 
    const aiTab = document.createElement("button");
    aiTab.textContent = "聊天设置";
    aiTab.className = "settings-tab active";
    aiTab.style.cssText = `
        padding: 9px 15px;
        background: rgba(0, 123, 255, 0.9);
        color: white;
        border: none;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-right: 5px;
    `;
 
    const advancedTab = document.createElement("button");
    advancedTab.textContent = "高级设置";
    advancedTab.className = "settings-tab";
    advancedTab.style.cssText = `
        padding: 9px 15px;
        background: rgba(0, 0, 0, 0.05);
        color: #333;
        border: none;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-right: 5px;
    `;
 
    tabsContainer.append(aiTab, advancedTab);
 
    const aiSettingsPanel = document.createElement("div");
    aiSettingsPanel.id = "ai-settings-panel";
var as=document.createElement("div");as.style.cssText="background:#f8fafc;border-radius:12px;padding:15px;margin-bottom:15px;border:1px solid #e2e8f0;";as.appendChild(Object.assign(document.createElement("h4"),{textContent:"AI API 配置",style:{margin:"0 0 12px",color:"#1e293b",fontSize:"15px",fontWeight:"600"}}));[{id:"ai-api-url-input",l:"API 地址",p:"https://api.deepseek.com/v1/chat/completions"},{id:"ai-api-key-input",l:"API Key",p:"sk-xxx",pw:!0},{id:"ai-model-input",l:"模型名称",p:"deepseek-chat"}].forEach(function(cf){as.appendChild(Object.assign(document.createElement("label"),{textContent:cf.l,style:{display:"block",marginBottom:"4px",fontSize:"12px",color:"#64748b"}}));var ip=Object.assign(document.createElement("input"),{type:cf.pw?"password":"text",id:cf.id,placeholder:cf.p});ip.style.cssText="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #d1d5db;font-size:13px;margin-bottom:10px;box-sizing:border-box;";as.appendChild(ip);});var aw=Object.assign(document.createElement("div"),{textContent:"Key存储在本地，请勿在公用电脑使用",style:{fontSize:"11px",color:"#f59e0b",marginBottom:"10px"}});as.appendChild(aw);var btnRow=document.createElement("div");btnRow.style.cssText="display:flex;gap:8px;margin-top:4px;";
var ab=document.createElement("button");ab.textContent="保存API配置";ab.style.cssText="flex:1;padding:8px;background:#4F46E5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;";
function collectApi(){var a=document.getElementById("ai-api-url-input");if(a)settings.aiApiUrl=a.value.trim();var b=document.getElementById("ai-api-key-input");if(b)settings.aiApiKey=b.value.trim();var c=document.getElementById("ai-model-input");if(c)settings.aiModel=c.value.trim()||"deepseek-chat";}
ab.addEventListener("click",function(){collectApi();saveSettings();showNotification("API 配置已保存");});
var tb=document.createElement("button");tb.textContent="测试连接";tb.style.cssText="flex:1;padding:8px;background:#fff;color:#4F46E5;border:1px solid #4F46E5;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;";
tb.addEventListener("click",async function(){collectApi();saveSettings();if(!settings.aiApiKey){showNotification("请先填写 API Key","error");return;}tb.disabled=true;tb.textContent="测试中...";try{var r=await Core.requestAi("你好，请只回复两个字：可用",null,{retries:0});showNotification(r?"连接成功："+String(r).slice(0,20):"连接失败，请检查配置","success");}catch(e){showNotification("连接失败："+e.message,"error");}finally{tb.disabled=false;tb.textContent="测试连接";}});
btnRow.appendChild(ab);btnRow.appendChild(tb);as.appendChild(btnRow);aiSettingsPanel.appendChild(as);

 
    const roleSettingResult = createSettingItem(
      "AI角色定位",
      "定义AI在对话中的角色和语气特点",
      () => document.getElementById("ai-role-input")
    );
 
    const roleSetting = roleSettingResult.settingItem;
 
    const roleInput = document.createElement("textarea");
    roleInput.id = "ai-role-input";
    roleInput.rows = 5;
    roleInput.style.cssText = `
        width: 100%;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        resize: vertical;
        font-size: 14px;
        transition: all 0.2s ease;
        margin-top: 10px;
        opacity: 1;
        pointer-events: auto;
    `;
 
    addFocusBlurEffects(roleInput);
    roleSetting.append(roleInput);
    aiSettingsPanel.append(roleSetting);
 
    const greetingsSettingResult = createSettingItem(
      "自我介绍",
      "首次沟通时依次发送的自我介绍内容",
      () => document.getElementById("greetings-container")
    );
 
    const greetingsSetting = greetingsSettingResult.settingItem;
    const greetingsContainer = document.createElement("div");
    greetingsContainer.id = "greetings-container";
    greetingsContainer.style.cssText = `
        width: 100%;
        margin-top: 10px;
    `;
 
    const greetingsList = document.createElement("div");
    greetingsList.id = "greetings-list";
    greetingsList.style.cssText = `
        max-height: 200px;
        overflow-y: auto;
        margin-bottom: 10px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px;
    `;
 
    const addGreetingBtn = document.createElement("button");
    addGreetingBtn.textContent = "添加自我介绍";
    addGreetingBtn.style.cssText = `
        padding: 6px 12px;
        border-radius: 4px;
        border: 1px solid rgba(0, 123, 255, 0.7);
        background: rgba(0, 123, 255, 0.1);
        color: rgba(0, 123, 255, 0.9);
        cursor: pointer;
        font-size: 13px;
        transition: all 0.2s ease;
        width: 100%;
        margin-top: 8px;
    `;
 
    addGreetingBtn.addEventListener("mouseenter", () => {
      addGreetingBtn.style.backgroundColor = "rgba(0, 123, 255, 0.2)";
    });
 
    addGreetingBtn.addEventListener("mouseleave", () => {
      addGreetingBtn.style.backgroundColor = "rgba(0, 123, 255, 0.1)";
    });
 
    addGreetingBtn.addEventListener("click", () => {
      addGreetingItem();
    });
 
    greetingsContainer.append(greetingsList, addGreetingBtn);
    greetingsSetting.append(greetingsContainer);
    
var rr=createSettingItem("个人简历","输入教育背景、技能栈等，AI据此生成个性化招呼语",function(){return document.getElementById("user-resume-input");});var rs=rr.settingItem;var ri=document.createElement("textarea");ri.id="user-resume-input";ri.rows=5;ri.placeholder="我叫Zion Cai，3年前端经验...";ri.style.cssText="width:100%;padding:12px;border-radius:8px;border:1px solid #d1d5db;resize:vertical;font-size:14px;margin-top:10px;box-sizing:border-box;";rs.appendChild(ri);aiSettingsPanel.appendChild(rs);var tr=createSettingItem("招呼语模板","使用 {resume} {job_title} {job_requirements} 占位符",function(){return document.getElementById("greeting-template-input");});var ts=tr.settingItem;var ti=document.createElement("textarea");ti.id="greeting-template-input";ti.rows=6;ti.placeholder="根据以下信息生成3-5条简短的打招呼消息...";ti.style.cssText="width:100%;padding:12px;border-radius:8px;border:1px solid #d1d5db;resize:vertical;font-size:14px;margin-top:10px;box-sizing:border-box;";ts.appendChild(ti);aiSettingsPanel.appendChild(ts);
var ir=createSettingItem("📤 导入简历 (Word / PDF / TXT)","支持 .docx .pdf .txt / .md，最大 5MB，自动识别并填入上方文本框",function(){return document.getElementById("resume-file-input");});
var ist=ir.settingItem;
var iz=document.createElement("div");iz.style.cssText="border:2px dashed #cbd5e1;border-radius:10px;padding:16px;text-align:center;cursor:pointer;margin-top:8px;";
iz.innerHTML='<div style="font-size:28px;">📂</div><div style="font-size:13px;color:#64748b;">点击上传简历文件</div><div style="font-size:11px;color:#94a3b8;">.docx .pdf .txt .md 最大 5MB</div>';
var fi=document.createElement("input");fi.type="file";fi.id="resume-file-input";fi.accept=".docx,.doc,.pdf,.txt,.md";fi.style.display="none";
var pd=document.createElement("div");pd.id="parsed-resume-result";pd.style.cssText="display:none;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:12px;color:#166534;";
iz.addEventListener("click",function(){fi.click();});
iz.addEventListener("dragover",function(e){e.preventDefault();iz.style.borderColor="#4F46E5";iz.style.background="#f5f3ff";});
iz.addEventListener("dragleave",function(){iz.style.borderColor="#cbd5e1";iz.style.background="";});
iz.addEventListener("drop",function(e){e.preventDefault();iz.style.borderColor="#cbd5e1";iz.style.background="";if(e.dataTransfer.files[0])prf(e.dataTransfer.files[0]);});
fi.addEventListener("change",function(e){if(e.target.files[0])prf(e.target.files[0]);});
async function prf(file){
  if(file.size>5242880){showNotification("文件不能超过 5MB","error");return;}
  var ext=(file.name.split(".").pop()||"").toLowerCase();
  try{
    var t="";
    if(ext==="txt"||ext==="md"){ t=await file.text(); }
    else if(ext==="docx"){ t=await extractTextFromDocx(await file.arrayBuffer()); }
    else if(ext==="doc"){
      showNotification("旧版 .doc 无法直接解析，请另存为 .docx 或 .txt","error");return;
    }
    else if(ext==="pdf"){ t=await extractTextFromPdf(await file.arrayBuffer()); }
    else { showNotification("不支持的文件类型：."+ext,"error");return; }

    t=(t||"").replace(/\n{3,}/g,"\n\n").trim();
    if(t.length<10){ showNotification("未识别出有效文本，建议改用 .docx 或 .txt","error");return; }

    var ru=document.getElementById("user-resume-input");
    if(ru)ru.value=t;
    settings.resume=t; saveSettings();
    pd.style.display="block";
    pd.innerHTML="<strong>✅ 已识别 "+file.name+"</strong><div style='margin-top:4px;color:#15803d;'>共 "+t.length+" 字，可在上方文本框中继续编辑</div>";
    iz.style.borderColor="#86efac"; iz.style.background="#f0fdf4";
    showNotification("简历已导入，记得点「保存设置」");
  }catch(err){
    console.error("[海投助手] 简历解析失败:",err);
    showNotification("解析失败："+err.message,"error");
  }finally{
    fi.value="";
  }
}
ist.appendChild(iz);ist.appendChild(fi);ist.appendChild(pd);aiSettingsPanel.appendChild(ist);

aiSettingsPanel.append(greetingsSetting);
 
    const advancedSettingsPanel = document.createElement("div");
    advancedSettingsPanel.id = "advanced-settings-panel";
    advancedSettingsPanel.style.display = "none";
 
    const autoReplySettingResult = createSettingItem(
      "Ai回复模式",
      "开启后Ai将自动回复消息",
      () => document.querySelector("#toggle-auto-reply-mode input")
    );
 
    const autoReplySetting = autoReplySettingResult.settingItem;
    const autoReplyDescriptionContainer =
      autoReplySettingResult.descriptionContainer;
 
    const autoReplyToggle = createToggleSwitch(
      "auto-reply-mode",
      settings.autoReply,
      (checked) => {
        settings.autoReply = checked;
      },
      true
    );
 
    autoReplyDescriptionContainer.append(autoReplyToggle);
 
    const autoSendResumeSettingResult = createSettingItem(
      "自动发送附件简历",
      "开启后系统将自动发送附件简历给HR",
      () => document.querySelector("#toggle-auto-send-resume input")
    );
 
    const autoSendResumeSetting = autoSendResumeSettingResult.settingItem;
    const autoSendResumeDescriptionContainer =
      autoSendResumeSettingResult.descriptionContainer;
 
    const autoSendResumeToggle = createToggleSwitch(
      "auto-send-resume",
      settings.useAutoSendResume,
      (checked) => {
        settings.useAutoSendResume = checked;
      },
      true
    );
 
    autoSendResumeDescriptionContainer.append(autoSendResumeToggle);
 
    const excludeHeadhuntersSettingResult = createSettingItem(
      "投递时排除猎头",
      "开启后将不会向猎头职位自动投递简历",
      () => document.querySelector("#toggle-exclude-headhunters input")
    );
 
    const excludeHeadhuntersSetting =
      excludeHeadhuntersSettingResult.settingItem;
    const excludeHeadhuntersDescriptionContainer =
      excludeHeadhuntersSettingResult.descriptionContainer;
 
    const excludeHeadhuntersToggle = createToggleSwitch(
      "exclude-headhunters",
      settings.excludeHeadhunters,
      (checked) => {
        settings.excludeHeadhunters = checked;
      },
      true
    );
 
    excludeHeadhuntersDescriptionContainer.append(excludeHeadhuntersToggle);
 
    const imageResumeSettingResult = createSettingItem(
      "发送图片简历",
      "首次沟通发送图片简历（需先选择JPG格式图片）",
      () => document.querySelector("#toggle-auto-send-image-resume input")
    );
 
    const imageResumeSetting = imageResumeSettingResult.settingItem;
    const imageResumeDescriptionContainer =
      imageResumeSettingResult.descriptionContainer;
 
    if (!state.settings.imageResumes) {
      state.settings.imageResumes = [];
    }
 
    const fileInputContainer = document.createElement("div");
    fileInputContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        margin-top: 10px;
    `;
 
    const addResumeBtn = document.createElement("button");
    addResumeBtn.id = "add-image-resume-btn";
    addResumeBtn.textContent = "添加图片简历";
    addResumeBtn.style.cssText = `
        padding: 8px 16px;
        border-radius: 6px;
        border: 1px solid rgba(0, 123, 255, 0.7);
        background: rgba(0, 123, 255, 0.1);
        color: rgba(0, 123, 255, 0.9);
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s ease;
        align-self: flex-start;
        white-space: nowrap;
    `;
 
    const fileNameDisplay = document.createElement("div");
    fileNameDisplay.id = "image-resume-filename";
    fileNameDisplay.style.cssText = `
        flex: 1;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        background: #f8fafc;
        color: #334155;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    const resumeCount = state.settings.imageResumes
      ? state.settings.imageResumes.length
      : 0;
    fileNameDisplay.textContent =
      resumeCount > 0 ? `已上传 ${resumeCount} 个简历` : "未选择文件";
 
    const autoSendImageResumeToggle = (() => {
      const hasImageResumes =
        state.settings.imageResumes && state.settings.imageResumes.length > 0;
      const isValidState = hasImageResumes && settings.useAutoSendImageResume;
      if (!hasImageResumes) settings.useAutoSendImageResume = false;
 
      return createToggleSwitch(
        "auto-send-image-resume",
        isValidState,
        (checked) => {
          if (
            checked &&
            (!state.settings.imageResumes ||
              state.settings.imageResumes.length === 0)
          ) {
            showNotification("请先选择图片文件", "error");
 
            const slider = document.querySelector(
              "#toggle-auto-send-image-resume .toggle-slider"
            );
            const container = document.querySelector(
              "#toggle-auto-send-image-resume .toggle-switch"
            );
 
            container.style.backgroundColor = "#e5e7eb";
            slider.style.transform = "translateX(0)";
            document.querySelector(
              "#toggle-auto-send-image-resume input"
            ).checked = false;
          }
          settings.useAutoSendImageResume = checked;
          return true;
        },
        true
      );
    })();
 
    const hiddenFileInput = document.createElement("input");
    hiddenFileInput.id = "image-resume-input";
    hiddenFileInput.type = "file";
    hiddenFileInput.accept = ".jpg,.jpeg";
    hiddenFileInput.style.display = "none";
 
    const uploadedResumesContainer = document.createElement("div");
    uploadedResumesContainer.id = "uploaded-resumes-container";
    uploadedResumesContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
    `;
 
    function renderResumeItem(index, resume) {
      const resumeItem = document.createElement("div");
      resumeItem.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.05);
            font-size: 14px;
        `;
 
      const fileNameSpan = document.createElement("span");
      fileNameSpan.textContent = resume.path;
      fileNameSpan.style.cssText = `
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-right: 8px;
        `;
 
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "删除";
      deleteBtn.style.cssText = `
            padding: 4px 12px;
            border-radius: 4px;
            border: 1px solid rgba(255, 70, 70, 0.7);
            background: rgba(255, 70, 70, 0.1);
            color: rgba(255, 70, 70, 0.9);
            cursor: pointer;
            font-size: 12px;
        `;
 
      deleteBtn.addEventListener("click", () => {
        state.settings.imageResumes.splice(index, 1);
 
        resumeItem.remove();
 
        if (state.settings.imageResumes.length === 0) {
          state.settings.useAutoSendImageResume = false;
          const toggleInput = document.querySelector(
            "#toggle-auto-send-image-resume input"
          );
          if (toggleInput) {
            toggleInput.checked = false;
            toggleInput.dispatchEvent(new Event("change"));
          }
        }
 
        if (
          typeof StatePersistence !== "undefined" &&
          StatePersistence.saveState
        ) {
          StatePersistence.saveState();
        }
      });
 
      resumeItem.appendChild(fileNameSpan);
      resumeItem.appendChild(deleteBtn);
 
      return resumeItem;
    }
 
    if (state.settings.imageResumes && state.settings.imageResumes.length > 0) {
      state.settings.imageResumes.forEach((resume, index) => {
        const resumeItem = renderResumeItem(index, resume);
        uploadedResumesContainer.appendChild(resumeItem);
      });
    }
 
    addResumeBtn.addEventListener("click", () => {
      if (state.settings.imageResumes.length >= 10) {
        showNotification("最多添加 10 个图片简历", "error");
      } else {
        hiddenFileInput.click();
      }
    });

    hiddenFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];

        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith('.jpg') && !fileName.endsWith('.jpeg')) {
          showNotification("仅支持 JPG/JPEG 格式的图片文件", "error");
          hiddenFileInput.value = "";
          return;
        }

        const isDuplicate = state.settings.imageResumes.some(
          (resume) => resume.path === file.name
        );
        if (isDuplicate) {
          showNotification("该文件名已存在", "error");
          return;
        }

        const reader = new FileReader();
        reader.onload = function (event) {
          const newResume = {
            path: file.name,
            data: event.target.result,
          };
 
          state.settings.imageResumes.push(newResume);
 
          const index = state.settings.imageResumes.length - 1;
          const resumeItem = renderResumeItem(index, newResume);
          uploadedResumesContainer.appendChild(resumeItem);
 
          if (!state.settings.useAutoSendImageResume) {
            state.settings.useAutoSendImageResume = true;
            const toggleInput = document.querySelector(
              "#toggle-auto-send-image-resume input"
            );
            if (toggleInput) {
              toggleInput.checked = true;
              toggleInput.dispatchEvent(new Event("change"));
            }
          }
 
          if (
            typeof StatePersistence !== "undefined" &&
            StatePersistence.saveState
          ) {
            StatePersistence.saveState();
          }
        };
        reader.readAsDataURL(file);
      }
    });
 
    fileInputContainer.append(
      addResumeBtn,
      uploadedResumesContainer,
      hiddenFileInput
    );
    imageResumeDescriptionContainer.append(autoSendImageResumeToggle);
    imageResumeSetting.append(fileInputContainer);
 
    const recruiterStatusSettingResult = createSettingItem(
      "投递招聘者状态（多选）",
      "筛选活跃状态符合要求的招聘者进行投递",
      () => document.querySelector("#recruiter-status-select .select-header")
    );
 
    const recruiterStatusSetting = recruiterStatusSettingResult.settingItem;
 
    const statusSelect = document.createElement("div");
    statusSelect.id = "recruiter-status-select";
    statusSelect.className = "custom-select";
    statusSelect.style.cssText = `
        position: relative;
        width: 100%;
        margin-top: 10px;
    `;
 
    const statusHeader = document.createElement("div");
    statusHeader.className = "select-header";
    statusHeader.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        background: white;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        min-height: 44px;
    `;
 
    const statusDisplay = document.createElement("div");
    statusDisplay.className = "select-value";
    statusDisplay.style.cssText = `
        flex: 1;
        text-align: left;
        color: #334155;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    statusDisplay.textContent = getStatusDisplayText();
 
    const statusIcon = document.createElement("div");
    statusIcon.className = "select-icon";
    statusIcon.innerHTML = "&#9660;";
    statusIcon.style.cssText = `
        margin-left: 10px;
        color: #64748b;
        transition: transform 0.2s ease;
    `;
 
    const statusClear = document.createElement("button");
    statusClear.className = "select-clear";
    statusClear.innerHTML = "×";
    statusClear.style.cssText = `
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        margin-left: 8px;
        display: none;
        transition: color 0.2s ease;
    `;
 
    statusHeader.append(statusDisplay, statusClear, statusIcon);
 
    const statusOptions = document.createElement("div");
    statusOptions.className = "select-options";
    statusOptions.style.cssText = `
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        max-height: 240px;
        overflow-y: auto;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        background: white;
        z-index: 100;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        display: none;
        transition: all 0.2s ease;
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 #f1f5f9;
    `;
 
    statusOptions.innerHTML += `
        <style>
            .select-options::-webkit-scrollbar {
                width: 6px;
            }
            .select-options::-webkit-scrollbar-track {
                background: #f1f5f9;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb {
                background: #cbd5e1;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb:hover {
                background: #94a3b8;
            }
        </style>
    `;
 
    const statusOptionsList = [
      { value: "不限", text: "不限" },
      { value: "在线", text: "在线" },
      { value: "刚刚活跃", text: "刚刚活跃" },
      { value: "今日活跃", text: "今日活跃" },
      { value: "3日内活跃", text: "3日内活跃" },
      { value: "本周活跃", text: "本周活跃" },
      { value: "本月活跃", text: "本月活跃" },
      { value: "半年前活跃", text: "半年前活跃" },
    ];
 
    statusOptionsList.forEach((option) => {
      const statusOption = document.createElement("div");
      statusOption.className =
        "select-option" +
        (settings.recruiterActivityStatus &&
          Array.isArray(settings.recruiterActivityStatus) &&
          settings.recruiterActivityStatus.includes(option.value)
          ? " selected"
          : "");
      statusOption.dataset.value = option.value;
      statusOption.style.cssText = `
            padding: 12px 16px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            font-size: 14px;
            color: #334155;
        `;
 
      const checkIcon = document.createElement("span");
      checkIcon.className = "check-icon";
      checkIcon.innerHTML = "✓";
      checkIcon.style.cssText = `
            margin-right: 8px;
            color: rgba(0, 123, 255, 0.9);
            font-weight: bold;
            display: ${settings.recruiterActivityStatus &&
          Array.isArray(settings.recruiterActivityStatus) &&
          settings.recruiterActivityStatus.includes(option.value)
          ? "inline"
          : "none"
        };
        `;
 
      const textSpan = document.createElement("span");
      textSpan.textContent = option.text;
 
      statusOption.append(checkIcon, textSpan);
 
      statusOption.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleStatusOption(option.value);
      });
 
      statusOptions.appendChild(statusOption);
    });
 
    statusHeader.addEventListener("click", () => {
      statusOptions.style.display =
        statusOptions.style.display === "block" ? "none" : "block";
      statusIcon.style.transform =
        statusOptions.style.display === "block"
          ? "rotate(180deg)"
          : "rotate(0)";
    });
 
    statusClear.addEventListener("click", (e) => {
      e.stopPropagation();
      settings.recruiterActivityStatus = ["不限"];
      saveSettings();
      updateStatusOptions();
    });
 
    document.addEventListener("click", (e) => {
      if (!statusSelect.contains(e.target)) {
        statusOptions.style.display = "none";
        statusIcon.style.transform = "rotate(0)";
      }
    });
 
    statusHeader.addEventListener("mouseenter", () => {
      statusHeader.style.borderColor = "rgba(0, 123, 255, 0.5)";
      statusHeader.style.boxShadow = "0 0 0 3px rgba(0, 123, 255, 0.1)";
    });
 
    statusHeader.addEventListener("mouseleave", () => {
      if (!statusHeader.contains(document.activeElement)) {
        statusHeader.style.borderColor = "#e2e8f0";
        statusHeader.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.05)";
      }
    });
 
    statusHeader.addEventListener("focus", () => {
      statusHeader.style.borderColor = "rgba(0, 123, 255, 0.7)";
      statusHeader.style.boxShadow = "0 0 0 3px rgba(0, 123, 255, 0.2)";
    });
 
    statusHeader.addEventListener("blur", () => {
      statusHeader.style.borderColor = "#e2e8f0";
      statusHeader.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.05)";
    });
 
    statusSelect.append(statusHeader, statusOptions);
    recruiterStatusSetting.append(statusSelect);

    // —— v2.1.0 新增：投递节奏与安全上限 ——
    const paceSettingResult = createSettingItem(
      "投递节奏 (毫秒)",
      "每投递一个岗位之间的间隔，建议 2000-5000，过小容易触发风控",
      () => document.getElementById("apply-interval-input")
    );
    const paceSetting = paceSettingResult.settingItem;
    const paceInput = document.createElement("input");
    paceInput.id = "apply-interval-input";
    paceInput.type = "number";
    paceInput.min = "800";
    paceInput.step = "100";
    paceInput.value = settings.applyInterval;
    paceInput.style.cssText =
      "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #d1d5db;font-size:13px;margin-top:10px;box-sizing:border-box;";
    paceSetting.append(paceInput);

    const limitSettingResult = createSettingItem(
      "单次投递上限",
      "一次运行最多投递多少个岗位，默认 50，避免投递过多",
      () => document.getElementById("max-apply-input")
    );
    const limitSetting = limitSettingResult.settingItem;
    const limitInput = document.createElement("input");
    limitInput.id = "max-apply-input";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.step = "1";
    limitInput.value = settings.maxApplyPerRun;
    limitInput.style.cssText =
      "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #d1d5db;font-size:13px;margin-top:10px;box-sizing:border-box;";
    limitSetting.append(limitInput);

    advancedSettingsPanel.append(paceSetting, limitSetting);
 
    advancedSettingsPanel.append(
      autoReplySetting,
      autoSendResumeSetting,
      excludeHeadhuntersSetting,
      imageResumeSetting,
      recruiterStatusSetting
    );
 
    aiTab.addEventListener("click", () => {
      setActiveTab(aiTab, aiSettingsPanel);
    });
 
    advancedTab.addEventListener("click", () => {
      setActiveTab(advancedTab, advancedSettingsPanel);
    });
 
    const dialogFooter = document.createElement("div");
    dialogFooter.style.cssText = `
        padding: 15px 20px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        background: rgba(0, 0, 0, 0.03);
    `;
 
    const cancelBtn = createTextButton("取消", "#e5e7eb", () => {
      dialog.style.display = "none";
    });
 
    const saveBtn = createTextButton(
      "保存设置",
      "rgba(0, 123, 255, 0.9)",
      () => {
        try {
          // 收集所有输入框的值再统一落盘（v2.1.0：不再只保存一部分字段）
          const val = (id) => {
            const el = document.getElementById(id);
            return el ? el.value : undefined;
          };

          const aiRole = val("ai-role-input");
          if (aiRole !== undefined) settings.aiRole = aiRole;

          const apiUrl = val("ai-api-url-input");
          if (apiUrl !== undefined) settings.aiApiUrl = apiUrl.trim();

          const apiKey = val("ai-api-key-input");
          if (apiKey !== undefined) settings.aiApiKey = apiKey.trim();

          const model = val("ai-model-input");
          if (model !== undefined) settings.aiModel = model.trim() || "deepseek-chat";

          const resume = val("user-resume-input");
          if (resume !== undefined) settings.resume = resume;

          const template = val("greeting-template-input");
          if (template !== undefined) settings.greetingTemplate = template;

          const intervalEl = val("apply-interval-input");
          if (intervalEl !== undefined && intervalEl !== "") {
            const n = parseInt(intervalEl, 10);
            if (!isNaN(n) && n >= 800) settings.applyInterval = n;
          }
          const maxEl = val("max-apply-input");
          if (maxEl !== undefined && maxEl !== "") {
            const n = parseInt(maxEl, 10);
            if (!isNaN(n) && n > 0) settings.maxApplyPerRun = n;
          }

          // 职位筛选关键词（弹窗里也能改）
          const incEl = document.getElementById("include-filter");
          if (incEl) {
            settings.includeKeywords = splitKeywords(incEl.value);
            state.includeKeywords = settings.includeKeywords;
          }
          const locEl = document.getElementById("location-filter");
          if (locEl) {
            settings.locationKeywords = splitKeywords(locEl.value);
            state.locationKeywords = settings.locationKeywords;
          }

          saveSettings();
          refreshPanelModeUI();
          showNotification("设置已保存");
          dialog.style.display = "none";
        } catch (error) {
          showNotification("保存失败: " + error.message, "error");
          console.error("[海投助手] 保存设置失败:", error);
        }
      }
    );
 
    dialogFooter.append(cancelBtn, saveBtn);
 
    dialogContent.append(
      tabsContainer,
      aiSettingsPanel,
      advancedSettingsPanel
    );
    dialog.append(dialogHeader, dialogContent, dialogFooter);
 
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        dialog.style.display = "none";
      }
    });
 
    return dialog;
  }
 
  function showSettingsDialog() {
    let dialog = document.getElementById("boss-settings-dialog");
    if (!dialog) {
      dialog = createSettingsDialog();
      document.body.appendChild(dialog);
    }
 
    dialog.style.display = "flex";
 
    setTimeout(() => {
      dialog.classList.add("active");
      setTimeout(loadSettingsIntoUI, 100);
    }, 10);
  }
 
  function toggleStatusOption(value) {
    if (value === "不限") {
      settings.recruiterActivityStatus =
        settings.recruiterActivityStatus.includes("不限") ? [] : ["不限"];
    } else {
      if (settings.recruiterActivityStatus.includes("不限")) {
        settings.recruiterActivityStatus = [value];
      } else {
        if (settings.recruiterActivityStatus.includes(value)) {
          settings.recruiterActivityStatus =
            settings.recruiterActivityStatus.filter((v) => v !== value);
        } else {
          settings.recruiterActivityStatus.push(value);
        }
 
        if (settings.recruiterActivityStatus.length === 0) {
          settings.recruiterActivityStatus = ["不限"];
        }
      }
    }
 
    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }
 
    updateStatusOptions();
  }
 
  function updateStatusOptions() {
    const options = document.querySelectorAll(
      "#recruiter-status-select .select-option"
    );
    options.forEach((option) => {
      const isSelected = settings.recruiterActivityStatus.includes(
        option.dataset.value
      );
      option.className = "select-option" + (isSelected ? " selected" : "");
      option.querySelector(".check-icon").style.display = isSelected
        ? "inline"
        : "none";
 
      if (option.dataset.value === "不限") {
        if (isSelected) {
          options.forEach((opt) => {
            if (opt.dataset.value !== "不限") {
              opt.className = "select-option";
              opt.querySelector(".check-icon").style.display = "none";
            }
          });
        }
      } else if (settings.recruiterActivityStatus.includes("不限")) {
        option.querySelector(".check-icon").style.display = "none";
        option.className = "select-option";
      }
    });
 
    document.querySelector(
      "#recruiter-status-select .select-value"
    ).textContent = getStatusDisplayText();
 
    document.querySelector(
      "#recruiter-status-select .select-clear"
    ).style.display =
      settings.recruiterActivityStatus.length > 0 &&
        !settings.recruiterActivityStatus.includes("不限")
        ? "inline"
        : "none";
 
    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }
  }
 
  function getStatusDisplayText() {
    if (settings.recruiterActivityStatus.includes("不限")) {
      return "不限";
    }
 
    if (settings.recruiterActivityStatus.length === 0) {
      return "请选择";
    }
 
    if (settings.recruiterActivityStatus.length <= 2) {
      return settings.recruiterActivityStatus.join("、");
    }
 
    return `${settings.recruiterActivityStatus[0]}、${settings.recruiterActivityStatus[1]}等${settings.recruiterActivityStatus.length}项`;
  }
 
  /**
   * 把配置回填到设置弹窗的各个控件。
   * v2.1.0 修复点：旧版这里没有回填「API 地址 / API Key / 模型 / 个人简历 / 招呼语模板」，
   * 用户打开弹窗看到空白输入框，点保存就把已保存的值覆盖成空 —— 表现为"刷新后配置全没了"。
   */
  function loadSettingsIntoUI() {
    // —— AI 角色 ——
    const aiRoleInput = document.getElementById("ai-role-input");
    if (aiRoleInput) aiRoleInput.value = settings.aiRole || "";

    // —— API 配置（旧版缺失）——
    const apiUrlInput = document.getElementById("ai-api-url-input");
    if (apiUrlInput) apiUrlInput.value = settings.aiApiUrl || "";
    const apiKeyInput = document.getElementById("ai-api-key-input");
    if (apiKeyInput) apiKeyInput.value = settings.aiApiKey || "";
    const modelInput = document.getElementById("ai-model-input");
    if (modelInput) modelInput.value = settings.aiModel || "";

    // —— 个人简历 / 招呼语模板（旧版缺失）——
    const resumeInput = document.getElementById("user-resume-input");
    if (resumeInput) resumeInput.value = settings.resume || "";
    const templateInput = document.getElementById("greeting-template-input");
    if (templateInput) templateInput.value = settings.greetingTemplate || "";

    // —— 开关（同步 checked 与滑块视觉状态）——
    syncToggle("auto-reply-mode", settings.autoReply);
    syncToggle("auto-send-resume", settings.useAutoSendResume);
    syncToggle("exclude-headhunters", settings.excludeHeadhunters);
    syncToggle(
      "auto-send-image-resume",
      !!(settings.useAutoSendImageResume &&
        settings.imageResumes &&
        settings.imageResumes.length > 0)
    );

    // —— 沟通页设置 ——
    const communicationModeSelector = document.querySelector(
      "#communication-mode-selector select"
    );
    if (communicationModeSelector) {
      communicationModeSelector.value = settings.communicationMode || "new-only";
    }
    const commInclude = document.querySelector("#communication-include");
    if (commInclude) {
      commInclude.value = settings.communicationIncludeKeywords || "";
    }
    if (elements.communicationIncludeInput) {
      elements.communicationIncludeInput.value =
        settings.communicationIncludeKeywords || "";
    }

    // —— 职位筛选条件 ——
    const includeInput = document.querySelector("#include-filter");
    if (includeInput) {
      includeInput.value = (state.includeKeywords ||
        settings.includeKeywords ||
        []
      ).join("，");
    }
    const locationInput = document.querySelector("#location-filter");
    if (locationInput) {
      locationInput.value = (state.locationKeywords ||
        settings.locationKeywords ||
        []
      ).join("，");
    }
    if (elements.includeInput) {
      elements.includeInput.value = (state.includeKeywords || []).join("，");
    }
    if (elements.locationInput) {
      elements.locationInput.value = (state.locationKeywords || []).join("，");
    }

    // —— 节奏 ——
    const applyIntervalInput = document.getElementById("apply-interval-input");
    if (applyIntervalInput) applyIntervalInput.value = settings.applyInterval;
    const maxApplyInput = document.getElementById("max-apply-input");
    if (maxApplyInput) maxApplyInput.value = settings.maxApplyPerRun;

    // —— 自我介绍列表 ——
    loadGreetings();

    // —— 招聘者活跃状态 ——
    updateStatusOptions();

    // —— 图片简历数量 ——
    refreshImageResumeCount();
  }

  /** 同步开关的勾选状态与滑块位置 */
  function syncToggle(id, checked) {
    const input = document.getElementById("toggle-" + id);
    if (!input) return;
    input.checked = !!checked;
    const container = input.closest(".toggle-switch");
    if (!container) return;
    const slider = container.querySelector(".toggle-slider");
    container.style.backgroundColor = checked
      ? "rgba(0, 123, 255, 0.9)"
      : "#e5e7eb";
    if (slider) slider.style.left = checked ? "27px" : "3px";
  }

  /** 刷新"已上传 N 个简历"文案 */
  function refreshImageResumeCount() {
    const display = document.getElementById("image-resume-filename");
    if (!display) return;
    const count =
      (settings.imageResumes && settings.imageResumes.length) || 0;
    display.textContent = count > 0 ? `已上传 ${count} 个简历` : "未选择文件";
  }

  /** 面板上的筛选输入框回填（上次填的筛选项不该每次重填） */
  function loadSettingsIntoUIFilters() {
    try {
      if (elements.includeInput) {
        elements.includeInput.value = (state.includeKeywords || []).join("，");
      }
      if (elements.locationInput) {
        elements.locationInput.value = (state.locationKeywords || []).join("，");
      }
    } catch (e) {}
  }
 
  function createDialogHeader(title, dialogId = "boss-settings-dialog") {
    const header = document.createElement("div");
    header.style.cssText = `
        padding: 16px 20px;
        background: #4F46E5;
        color: white;
        font-size: 18px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
        border-radius: 12px 12px 0 0;
    `;
 
    const titleElement = document.createElement("div");
    titleElement.textContent = title;
    titleElement.style.fontWeight = "600";
 
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.title = "关闭";
    closeBtn.style.cssText = `
        width: 28px;
        height: 28px;
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 50%;
        display: flex;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
        font-size: 16px;
        font-weight: bold;
    `;
 
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.3)";
      closeBtn.style.transform = "scale(1.1)";
    });
 
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
      closeBtn.style.transform = "scale(1)";
    });
 
    closeBtn.addEventListener("click", () => {
      const dialog = document.getElementById(dialogId);
      if (dialog) {
        dialog.style.display = "none";
      }
    });
 
    header.append(titleElement, closeBtn);
    return header;
  }
 
  function showActivationDialog() {}

  function createSettingItem(title, description, controlGetter) {
    const settingItem = document.createElement("div");
    settingItem.className = "setting-item";
    settingItem.style.cssText = `
        padding: 15px;
        border-radius: 10px;
        margin-bottom: 15px;
        background: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        border: 1px solid rgba(0, 123, 255, 0.1);
        display: flex;
        flex-direction: column;
    `;
 
    const titleElement = document.createElement("h4");
    titleElement.textContent = title;
    titleElement.style.cssText = `
        margin: 0 0 5px;
        color: #333;
        font-size: 16px;
        font-weight: 500;
    `;
 
    const descElement = document.createElement("p");
    descElement.textContent = description;
    descElement.style.cssText = `
        margin: 0;
        color: #666;
        font-size: 13px;
        line-height: 1.4;
    `;
 
    const descriptionContainer = document.createElement("div");
    descriptionContainer.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    `;
 
    const textContainer = document.createElement("div");
    textContainer.append(titleElement, descElement);
 
    descriptionContainer.append(textContainer);
 
    settingItem.append(descriptionContainer);
 
    settingItem.addEventListener("click", () => {
      const control = controlGetter();
      if (control && typeof control.focus === "function") {
        control.focus();
      }
    });
 
    return {
      settingItem,
      descriptionContainer,
    };
  }
 
  function createToggleSwitch(
    id,
    isChecked,
    onChange) {
    const container = document.createElement("div");
    container.className = "toggle-container";
    container.style.cssText =
      "display: flex; justify-content: space-between; align-items: center;";
 
    const switchContainer = document.createElement("div");
    switchContainer.className = "toggle-switch";
 
    switchContainer.style.cssText = `
        position: relative;
        width: 50px;
        height: 26px;
        border-radius: 13px;
        background-color: ${isChecked ? "rgba(0, 123, 255, 0.9)" : "#e5e7eb"
      };
        cursor: pointer;
        opacity: 1;
    `;
 
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `toggle-${id}`;
    checkbox.checked = isChecked;
    checkbox.style.display = "none";
 
    const slider = document.createElement("span");
    slider.className = "toggle-slider";
    slider.style.cssText = `
        position: absolute;
        top: 3px;
        left: ${isChecked ? "27px" : "3px"};
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: none;
    `;
 
    const forceUpdateUI = (checked) => {
      
 
      checkbox.checked = checked;
      switchContainer.style.backgroundColor = checked
        ? "rgba(0, 123, 255, 0.9)"
        : "#e5e7eb";
      slider.style.left = checked ? "27px" : "3px";
    };
 
    checkbox.addEventListener("change", () => {
      if (false) {
        forceUpdateUI(!checkbox.checked);
        return;
      }
 
      let allowChange = true;
 
      if (onChange) {
        allowChange = onChange(checkbox.checked) !== false;
      }
 
      if (!allowChange) {
        forceUpdateUI(!checkbox.checked);
        return;
      }
 
      forceUpdateUI(checkbox.checked);
    });
 
    switchContainer.addEventListener("click", () => {
      if (false) {
        showActivationDialog();
        return;
      }
 
      const newState = !checkbox.checked;
 
      if (onChange) {
        if (onChange(newState) !== false) {
          forceUpdateUI(newState);
        }
      } else {
        forceUpdateUI(newState);
      }
    });
 
    switchContainer.append(checkbox, slider);
    container.append(switchContainer);
 
    return container;
  }
 
  function createTextButton(text, backgroundColor, onClick) {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.cssText = `
        padding: 9px 18px;
        border-radius: 8px;
        border: none;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        background: ${backgroundColor};
        color: white;
    `;
 
    button.addEventListener("click", onClick);
 
    return button;
  }
 
  function addFocusBlurEffects(element) {
    element.addEventListener("focus", () => {
      element.style.borderColor = "rgba(0, 123, 255, 0.7)";
      element.style.boxShadow = "0 0 0 3px rgba(0, 123, 255, 0.2)";
    });
 
    element.addEventListener("blur", () => {
      element.style.borderColor = "#d1d5db";
      element.style.boxShadow = "none";
    });
  }
 
  function setActiveTab(tab, panel) {
    const tabs = document.querySelectorAll(".settings-tab");
    const panels = [
      document.getElementById("ai-settings-panel"),
      document.getElementById("advanced-settings-panel"),
    ];
 
    tabs.forEach((t) => {
      t.classList.remove("active");
      t.style.backgroundColor = "rgba(0, 0, 0, 0.05)";
      t.style.color = "#333";
    });
 
    panels.forEach((p) => {
      p.style.display = "none";
    });
 
    tab.classList.add("active");
    tab.style.backgroundColor = "rgba(0, 123, 255, 0.9)";
    tab.style.color = "white";
 
    panel.style.display = "block";
  }
 
  /**
   * v2.1.0：统一刷新面板上与"模式"相关的 UI（AI 开关、按钮文案、预览区显隐）。
   * 旧版这个逻辑散落在匿名闭包里，导致 settings.aiGreetingEnabled 为 undefined 时
   * 开关看起来是关的、按钮文案也对不上。
   */
  function refreshPanelModeUI() {
    try {
      const on = !!settings.aiGreetingEnabled;

      const sw = document.getElementById("ai-greeting-toggle");
      const th = document.getElementById("ai-greeting-thumb");
      if (sw) sw.style.background = on ? "#4F46E5" : "#cbd5e1";
      if (th) th.style.left = on ? "25px" : "3px";

      const preview = document.getElementById("greeting-preview-section");
      if (preview) preview.style.display = on ? "block" : "none";

      if (elements.controlBtn && !state.isRunning) {
        elements.controlBtn.textContent = on ? "🚀 一键投递" : "▶ 启动海投";
        elements.controlBtn.style.background = "var(--primary-color)";
      }

      // 同步开关旁边的小字说明
      const hint = document.getElementById("ai-greeting-mode-hint");
      if (hint) {
        hint.textContent = on
          ? "半自动：AI 生成招呼语，确认后投递"
          : "全自动：批量自动沟通";
        hint.style.color = on ? "#4F46E5" : "#94a3b8";
      }
    } catch (e) {
      console.error("[海投助手] 刷新模式 UI 失败:", e);
    }
  }

  /** v2.1.0：刷新面板底部的运行统计 */
  function refreshStatsUI() {
    const map = {
      "stat-greeted": state.stats.greeted,
      "stat-resumed": state.stats.resumed,
      "stat-skipped": state.stats.skipped,
      "stat-failed": state.stats.failed,
    };
    Object.keys(map).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(map[id]);
    });
  }

  function resetStats() {
    state.stats.greeted = 0;
    state.stats.resumed = 0;
    state.stats.skipped = 0;
    state.stats.failed = 0;
    state.stats.startTime = Date.now();
    refreshStatsUI();
  }

  function showNotification(message, type = "success") {
    const notification = document.createElement("div");
    const bgColor =
      type === "success" ? "rgba(40, 167, 69, 0.9)" : "rgba(220, 53, 69, 0.9)";
 
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${bgColor};
        color: white;
        padding: 10px 15px;
        border-radius: 8px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.2);
        z-index: 9999999;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
 
    notification.textContent = message;
    document.body.appendChild(notification);
 
    setTimeout(() => (notification.style.opacity = "1"), 10);
    setTimeout(() => {
      notification.style.opacity = "0";
      setTimeout(() => document.body.removeChild(notification), 300);
    }, 2000);
  }
 
  const Core = {
    CONFIG,
 
    messageObserver: null,
    lastProcessedMessage: null,
    processingMessage: false,
    currentMonitoredHR: null,
 
    domCache: {},
 
    getCachedElement(selector, forceRefresh = false) {
      if (forceRefresh || !this.domCache[selector]) {
        this.domCache[selector] = document.querySelector(selector);
      }
      return this.domCache[selector];
    },
 
    getCachedElements(selector, forceRefresh = false) {
      if (forceRefresh || !this.domCache[selector + "[]"]) {
        this.domCache[selector + "[]"] = document.querySelectorAll(selector);
      }
      return this.domCache[selector + "[]"];
    },
 
    clearDomCache() {
      this.domCache = {};
    },
 
    extractJobInfo(card) {
      try {
        const jobLink = card.querySelector('a[href*="/job_detail/"]');
        if (!jobLink) {
          this.log('未找到职位详情链接');
          return null;
        }
 
        const href = jobLink.getAttribute('href');
        this.log(`职位链接: ${href}`);
 
        const jobIdMatch = href.match(/job_detail\/([^.]+)\.html/);
        if (!jobIdMatch) {
          this.log('无法提取jobId');
          return null;
        }
 
        const jobId = jobIdMatch[1];
        const securityIdMatch = href.match(/securityId=([^&]+)/);
        const securityId = securityIdMatch ? securityIdMatch[1] : null;
 
        const lidMatch = href.match(/lid=([^&]+)/);
        const lid = lidMatch ? lidMatch[1] : '';
 
        this.log(`提取信息 - jobId: ${jobId}, securityId: ${securityId ? '已获取' : '未找到'}, lid: ${lid}`);
 
        return {
          jobId,
          securityId,
          lid
        };
      } catch (error) {
        this.log(`提取职位信息失败: ${error.message}`);
        return null;
      }
    },
 
    async sendFriendRequest(jobId, securityId, lid) {
      try {
        if (!securityId) {
          throw new Error('缺少securityId参数');
        }
 
        const timestamp = Date.now();
        const url = `/wapi/zpgeek/friend/add.json?securityId=${encodeURIComponent(securityId)}&jobId=${encodeURIComponent(jobId || '')}&lid=${encodeURIComponent(lid || '')}&_=${timestamp}`;
 
        const response = await fetch(url, {
          method: 'POST',
          body: 'sessionId='
        });
 
        const result = await response.json();
 
        if (result.code === 0) {
          return result;
        } else {
          throw new Error(result.message || '请求失败');
        }
      } catch (error) {
        throw error;
      }
    },
 
    /* =====================================================================
     * v2.1.0 重写：投递主流程
     *
     * 旧版致命问题：
     *   1) 用 location.pathname.includes("/jobs") 判断页面，而真实地址是
     *      /web/geek/job（无 s） → while 循环里两个分支都不命中，
     *      表现就是"脚本只是在找，不会投递"；
     *   2) 把 li.job-card-box 的 DOM 节点缓存进 state.jobList，BOSS 在点击后会
     *      重新渲染列表，缓存节点变成游离节点，后续 click() 全部无效；
     *   3) 点完「立即沟通」后只点了"留在此页"，既不校验是否真的投递成功，
     *      也不会发送 AI 生成的招呼语。
     * ===================================================================== */

    /** 取页面上的职位卡片（兼容两种 DOM 结构） */
    getJobCards() {
      let cards = Array.from(document.querySelectorAll("li.job-card-box"));
      if (!cards.length) {
        cards = Array.from(
          document.querySelectorAll(".job-list-box .job-card-wrapper, ul.job-list-box > li")
        );
      }
      return cards;
    },

    /** 取职位的稳定标识（优先 jobId，其次标题+公司） */
    getCardJobId(card) {
      if (!card) return null;
      try {
        if (card.dataset && (card.dataset.jobid || card.dataset.lid)) {
          return card.dataset.jobid || card.dataset.lid;
        }
        const a =
          card.querySelector('a[href*="/job_detail/"]') ||
          (card.tagName === "A" ? card : null);
        if (a) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/job_detail\/([^.\/?#]+)\.html/);
          if (m) return m[1];
        }
        const inner = card.querySelector("[data-jobid]");
        if (inner && inner.dataset.jobid) return inner.dataset.jobid;

        const t = card.querySelector(".job-name");
        const c = card.querySelector(".company-name, .company-info .name");
        if (t) {
          return (
            t.textContent.trim() + "|" + (c ? c.textContent.trim() : "")
          ).slice(0, 120);
        }
      } catch (e) {}
      return null;
    },

    /** 按标识重新查一次卡片，避免使用已被 React 替换掉的游离节点 */
    findCardById(jobId) {
      if (!jobId) return null;
      const cards = this.getJobCards();
      for (const c of cards) {
        if (this.getCardJobId(c) === jobId) return c;
      }
      return null;
    },

    /** 当前被用户点选的职位卡片（AI 招呼语 → 一键投递 的衔接） */
    getSelectedCard() {
      if (state.currentJobKey) {
        const byKey = this.findCardById(state.currentJobKey);
        if (byKey) return byKey;
      }
      const active = document.querySelector(
        "li.job-card-box.active, li.job-card-box.selected, .job-card-wrapper.active"
      );
      return active || this.getJobCards()[0] || null;
    },

    async startProcessing() {
      // —— 聊天页：监听并自动回复 ——
      if (PAGE.isChat()) {
        this.log("开始监听招聘者消息…");
        while (state.isRunning) {
          try {
            await this.handleChatPage();
          } catch (e) {
            this.log(`聊天处理异常: ${e.message}`);
          }
          await this.delay(CONFIG.BASIC_INTERVAL);
        }
        return;
      }

      // —— 非职位页：给出明确提示而不是静默空转（旧版就是在这里什么都不做）——
      if (!PAGE.isJobList()) {
        this.log("当前页面不是职位列表，请打开 www.zhipin.com/web/geek/jobs 后重试");
        if (state.isRunning) toggleProcess();
        return;
      }

      resetStats();

      // 1. 自动滚动加载全部岗位
      await this.autoScrollJobList();
      if (!state.isRunning) return;

      // 2. 收集岗位（只存标识，不存 DOM 节点）并应用筛选条件
      const allCards = this.getJobCards();
      const cards = this.filterJobCards(allCards);
      if (!cards.length) {
        this.log(
          allCards.length
            ? `共 ${allCards.length} 个岗位，但没有符合筛选条件的（自定义筛选：${(state.includeKeywords || []).join("、") || "无"} / ${(state.locationKeywords || []).join("、") || "无"}）`
            : "页面上没有找到职位卡片，请确认职位列表已加载完成（可先手动搜索一次）"
        );
        if (state.isRunning) toggleProcess();
        return;
      }
      this.log(
        `筛选后共 ${cards.length}/${allCards.length} 个职位，开始逐个沟通…`
      );

      const maxApply = settings.maxApplyPerRun || CONFIG.SAFETY.MAX_APPLY_PER_RUN;
      const interval = Math.max(
        800,
        settings.applyInterval || CONFIG.SAFETY.APPLY_INTERVAL
      );
      const done = new Set();
      let applied = 0;

      for (let i = 0; i < cards.length; i++) {
        if (!state.isRunning) break;
        if (applied >= maxApply) {
          this.log(`已达到单次投递上限 ${maxApply} 个，自动停止（可在设置中调整）`);
          break;
        }

        state.currentIndex = i;
        const jobId = this.getCardJobId(cards[i]);

        if (jobId && done.has(jobId)) {
          continue;
        }
        if (jobId) done.add(jobId);

        try {
          const ok = await this.processOneJob(cards[i], i, cards.length);
          if (ok) applied++;
        } catch (e) {
          state.stats.failed++;
          refreshStatsUI();
          this.log(`处理第 ${i + 1} 个职位出错：${e.message}`);
        }

        await this.delay(interval);
      }

      if (state.isRunning) {
        this.log(
          `本次运行结束：成功沟通 ${applied} 个，跳过 ${state.stats.skipped} 个，失败 ${state.stats.failed} 个`
        );
        toggleProcess();
      }
    },

    /** 自动滚动加载岗位列表（旧版没有步数上限，页面持续增长时会无限递归） */
    async autoScrollJobList() {
      return new Promise((resolve) => {
        const waitTime = CONFIG.BASIC_INTERVAL;
        const maxSteps = CONFIG.SAFETY.MAX_SCROLL_STEPS;
        let history = [];
        let step = 0;
        let stopped = false;

        this.stopAutoScroll = () => {
          stopped = true;
          resolve(null);
        };

        const scrollStep = async () => {
          if (stopped || !state.isRunning) return resolve(null);
          step++;

          const cards = this.getJobCards();
          history.push(cards.length);
          if (history.length > 3) history.shift();

          const stable =
            history.length === 3 && new Set(history).size === 1;

          if (stable || step >= maxSteps) {
            this.log(
              `岗位列表加载完成，共 ${cards.length} 个${step >= maxSteps ? "（已达滚动上限）" : ""}`
            );
            return resolve(cards);
          }

          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: "smooth",
          });
          await this.delay(waitTime);
          scrollStep();
        };

        scrollStep();
      });
    },

    /** 读取招聘者活跃状态 */
    getRecruiterActiveTime() {
      try {
        const onlineTag = document.querySelector(".boss-online-tag");
        if (onlineTag && onlineTag.textContent.trim() === "在线") return "在线";
        const el =
          document.querySelector(".boss-active-time") ||
          document.querySelector(".job-detail-box .boss-active-time");
        return (el && el.textContent.trim()) || "未知";
      } catch (e) {
        return "未知";
      }
    },

    /**
     * 找到详情区的沟通按钮。
     * v2.1.0 修复：旧版用 document.querySelector("a.op-btn-chat")，
     * 而职位卡片的底部按钮也用同一个 class，于是永远取到的是"卡片上的按钮"，
     * 点完之后按钮变成"继续沟通"，下一个职位又被判定为"已沟通过" → 表现为只找不投递。
     * 因此这里必须优先在详情区里找。
     */
    findChatButton() {
      const detailScopes = [
        ".job-detail-op",
        ".job-detail-box",
        ".job-detail-section",
        ".job-detail-container",
        ".detail-content",
        "#job-detail",
      ];
      const innerSelectors = [
        "a.op-btn-chat",
        ".op-btn-chat",
        "a.btn-startchat",
        ".btn-startchat",
        "a[ka*='job-detail-chat']",
        "a[href*='chat']",
        ".btn.btn-primary",
      ];

      const isChatText = (el) => {
        const text = (el.textContent || "").replace(/\s+/g, "");
        return (
          text.indexOf("沟通") !== -1 ||
          text.indexOf("投递") !== -1 ||
          text.indexOf("打招呼") !== -1
        );
      };

      // 1) 优先在详情区里找
      for (const scope of detailScopes) {
        const root = document.querySelector(scope);
        if (!root) continue;
        for (const sel of innerSelectors) {
          const els = root.querySelectorAll(sel);
          for (const el of els) {
            if (isChatText(el)) return el;
          }
        }
      }

      // 2) 兜底：排除职位卡片上的按钮
      for (const sel of innerSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!isChatText(el)) continue;
          if (el.closest("li.job-card-box, .job-card-wrapper")) continue;
          return el;
        }
      }

      return null;
    },

    /** 按"职位名/工作地/是否猎头"筛选卡片（旧版逻辑保留，抽成独立方法便于复用） */
    filterJobCards(cards) {
      const includeKeywords = state.includeKeywords || [];
      const locationKeywords = state.locationKeywords || [];
      const excludeHeadhunters = !!settings.excludeHeadhunters;

      return (cards || []).filter((card) => {
        if (!card) return false;
        const title = (
          card.querySelector(".job-name")?.textContent || ""
        ).toLowerCase();

        const addressText = (
          card.querySelector(".job-address-desc")?.textContent ||
          card.querySelector(".company-location")?.textContent ||
          card.querySelector(".job-area")?.textContent ||
          ""
        )
          .toLowerCase()
          .trim();

        const includeMatch =
          includeKeywords.length === 0 ||
          includeKeywords.some((kw) => kw && title.includes(kw.trim()));

        const locationMatch =
          locationKeywords.length === 0 ||
          locationKeywords.some((kw) => kw && addressText.includes(kw.trim()));

        let excludeHeadhunterMatch = true;
        if (excludeHeadhunters) {
          const tagEl = card.querySelector(".job-tag-icon");
          const altText = tagEl ? tagEl.alt || "" : "";
          const cardText = card.textContent || "";
          excludeHeadhunterMatch =
            altText.indexOf("猎头") === -1 && cardText.indexOf("猎头") === -1;
        }

        return includeMatch && locationMatch && excludeHeadhunterMatch;
      });
    },

    /**
     * 找职位卡片自带的「立即沟通」按钮。
     * 直接点卡片上的按钮比"先点卡片、再等详情区刷新"稳定得多，
     * 也是真人最常用的操作路径。
     */
    getCardChatButton(card) {
      if (!card) return null;
      const selectors = [
        ".job-card-footer a.op-btn-chat",
        "a.op-btn-chat",
        ".op-btn-chat",
        ".btn-startchat",
        ".job-card-footer .btn",
        ".start-chat-btn",
      ];
      for (const sel of selectors) {
        const el = card.querySelector(sel);
        if (el) return el;
      }
      return null;
    },

    /** 按钮文案归一化 */
    normalizeBtnText(text) {
      return String(text || "")
        .replace(/\s+/g, "")
        .trim();
    },

    isAlreadyGreeted(text) {
      const t = this.normalizeBtnText(text);
      return (
        t.indexOf("继续沟通") !== -1 ||
        t.indexOf("继续聊") !== -1 ||
        t.indexOf("已沟通") !== -1 ||
        t.indexOf("已投递") !== -1
      );
    },

    isGreetButton(text) {
      const t = this.normalizeBtnText(text);
      return t.indexOf("立即沟通") !== -1 || t === "沟通" || t.indexOf("打招呼") !== -1;
    },

    /** 处理单个职位：过滤 → 沟通 → 校验 */
    async processOneJob(card, index, total) {
      if (!card) return false;

      const jobId = this.getCardJobId(card);
      const titleEl = card.querySelector(".job-name");
      const title = titleEl ? titleEl.textContent.trim() : "未知职位";
      const label = `[${index + 1}/${total}] ${title}`;

      // 节点可能已被 React 重新渲染替换，按标识重新查一次
      let liveCard = jobId ? this.findCardById(jobId) : card;
      if (!liveCard) liveCard = card;

      // 1) 先看卡片自身的按钮状态
      let cardBtn = this.getCardChatButton(liveCard);
      let btnText = cardBtn ? cardBtn.textContent : "";

      if (cardBtn && this.isAlreadyGreeted(btnText)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} 已沟通过，跳过`);
        return false;
      }

      // 2) 卡片上没有沟通按钮时，才点开详情去找
      if (!cardBtn || !this.isGreetButton(btnText)) {
        liveCard.scrollIntoView({ behavior: "smooth", block: "center" });
        await this.delay(300);
        this.simulateClickSync(liveCard);

        const detailBtn = await this.waitForElement(
          () => this.findChatButton(),
          CONFIG.OPERATION_INTERVAL * 3
        );
        if (detailBtn && !this.isAlreadyGreeted(detailBtn.textContent)) {
          cardBtn = detailBtn;
          btnText = detailBtn.textContent;
        }
      }

      if (!cardBtn) {
        state.stats.failed++;
        refreshStatsUI();
        this.log(`${label} 未找到「立即沟通」按钮，可能页面结构已变化`);
        return false;
      }

      if (!this.isGreetButton(btnText)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} 按钮文案为「${this.normalizeBtnText(btnText)}」，跳过`);
        return false;
      }

      // 3) 招聘者活跃状态过滤
      const activeTime = this.getRecruiterActiveTime();
      const filter = settings.recruiterActivityStatus || ["不限"];
      if (!filter.includes("不限") && !filter.includes(activeTime)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} 跳过：招聘者状态「${activeTime}」不在筛选范围内`);
        return false;
      }

      // 4) 执行沟通
      const greeting = this.pickGreetingText(title);
      const ok = await this.applyToJob(liveCard, cardBtn, label, greeting);

      if (ok) {
        state.stats.greeted++;
        refreshStatsUI();
        if (jobId) {
          try {
            StorageManager.addRecordWithLimit(
              CONFIG.STORAGE_KEYS.PROCESSED_HRS,
              jobId,
              state.hrInteractions.processedHRs,
              CONFIG.STORAGE_LIMITS.PROCESSED_HRS
            );
          } catch (e) {}
        }
      } else {
        state.stats.failed++;
        refreshStatsUI();
      }
      return ok;
    },

    /** 选取要发送的招呼语：AI 预览优先，其次自我介绍列表 */
    pickGreetingText(jobTitle) {
      try {
        const preview = document.getElementById("greeting-preview-text");
        const previewText = preview ? (preview.value || "").trim() : "";
        if (settings.aiGreetingEnabled && previewText) {
          return previewText;
        }
        const list = (state.settings.greetingsList || [])
          .map((g) => (g.content || "").trim())
          .filter(Boolean);
        return list.join("\n");
      } catch (e) {
        return "";
      }
    },

    /**
     * 真正执行一次投递，并校验结果。
     * 返回 true 表示这次沟通确实生效。
     */
    async applyToJob(card, chatBtn, label, greeting) {
      const beforeText = (chatBtn.textContent || "").replace(/\s+/g, "");

      // 优先尝试站内接口（可选，默认关闭：接口易变且风控风险更高）
      if (settings.useApiApply) {
        const info = this.extractJobInfo(card);
        let sec = APIInterceptor.getCurrentSecurityId();
        if (!sec && info && info.securityId) {
          sec = { securityId: info.securityId, lid: info.lid, jobId: info.jobId };
        }
        if (sec && sec.securityId) {
          try {
            await this.sendFriendRequest(
              sec.jobId || (info && info.jobId) || "",
              sec.securityId,
              sec.lid || ""
            );
            this.log(`${label} 已通过站内接口发起沟通`);
            await this.trySendGreetingText(greeting, label);
            return true;
          } catch (e) {
            this.log(`${label} 接口方式失败（${e.message}），回退到模拟点击`);
          }
        }
      }

      // 模拟点击
      await this.simulateClick(chatBtn);

      const result = await this.waitApplyResult(beforeText, chatBtn);

      if (!result.ok) {
        this.log(`${label} 沟通结果未知：没有检测到成功提示，也未看到按钮变化`);
        return false;
      }

      // 如果能找到输入框，把招呼语真正发出去
      await this.trySendGreetingText(greeting, label);

      // 停留在此页，继续处理下一个岗位（点"去沟通"会跳走并中断批量）
      await this.closeGreetingModal();
      return true;
    },

    /** 等待投递结果：按钮文案变化 / 弹窗 / 出现聊天输入框 / toast 提示 */
    async waitApplyResult(beforeText, clickedBtn, timeout = 8000) {
      const start = Date.now();
      const before = this.normalizeBtnText(beforeText);

      while (Date.now() - start < timeout) {
        // 1) 被点的按钮文案变化（立即沟通 → 继续沟通）
        if (clickedBtn && clickedBtn.isConnected) {
          const now = this.normalizeBtnText(clickedBtn.textContent);
          if (now && now !== before) return { ok: true, reason: "button-changed" };
        }

        // 2) 出现打招呼弹窗
        const modal = document.querySelector(
          '.greet-boss-dialog, .dialog-container, .dialog-wrap, [class*="greet"][class*="dialog"]'
        );
        if (modal) return { ok: true, reason: "modal" };

        // 3) 出现聊天输入框（说明已进入沟通）
        if (
          document.querySelector(
            "#chat-input, .chat-input, .input-area textarea, .chat-input-box textarea"
          )
        ) {
          return { ok: true, reason: "chat-opened" };
        }

        // 4) 全局 toast 提示
        const toast = document.querySelector(
          ".toast, .message-tip, .ui-tip, [class*='toast']"
        );
        if (
          toast &&
          /成功|已发送|已投递|已沟通|打招呼|发送成功/.test(toast.textContent || "")
        ) {
          return { ok: true, reason: "toast" };
        }

        await this.delay(200);
      }
      return { ok: false };
    },

    /** 尝试把招呼语写进输入框并发送 */
    async trySendGreetingText(greeting, label) {
      if (!greeting || !greeting.trim()) return false;
      try {
        const findInput = () =>
          document.querySelector(
            "#chat-input, .chat-input, .greet-boss-dialog textarea, .dialog-container textarea, .input-area textarea, .chat-input-box textarea"
          );

        // 先同步查一次，没有再短暂等待，避免每个岗位都空等
        let input = findInput();
        if (!input) {
          input = await this.waitForElement(findInput, CONFIG.OPERATION_INTERVAL);
        }
        if (!input) {
          this.log(
            `${label} 已发起沟通（BOSS 会使用「打招呼语设置」里的默认招呼语；想发送自定义招呼语请到 BOSS 设置页开启打招呼语）`
          );
          return false;
        }

        const messages = String(greeting)
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);

        for (const msg of messages) {
          if (input.tagName === "TEXTAREA" || input.getAttribute("contenteditable")) {
            input.focus();
            if (input.value !== undefined) input.value = msg;
            else input.textContent = msg;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            input.focus();
            document.execCommand("insertText", false, msg);
          }
          await this.delay(200);

          const sendBtn =
            document.querySelector(".btn-send") ||
            document.querySelector(".send-btn");
          if (sendBtn) {
            await this.simulateClick(sendBtn);
          } else if (input.dispatchEvent) {
            input.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
              })
            );
          }
          await this.delay(600);
        }

        this.log(`${label} 已发送招呼语（${messages.length} 条）`);
        return true;
      } catch (e) {
        this.log(`${label} 发送招呼语失败：${e.message}`);
        return false;
      }
    },

    /** 关闭打招呼弹窗并留在当前列表页 */
    async closeGreetingModal() {
      await this.delay(600);
      try {
        const candidates = Array.from(
          document.querySelectorAll(
            ".default-btn.cancel-btn, .dialog-container button, .greet-boss-dialog button, .dialog-wrap button"
          )
        );
        const stay = candidates.find((b) => {
          const t = (b.textContent || "").replace(/\s+/g, "");
          return (
            t === "留在此页" ||
            t === "取消" ||
            t === "稍后" ||
            t === "关闭" ||
            t === "知道了"
          );
        });
        if (stay) {
          await this.simulateClick(stay);
          await this.delay(400);
        }
      } catch (e) {}
    },

    /** 兼容旧调用点 */
    async handleGreetingModal() {
      await this.closeGreetingModal();
    },

    /** 同步版点击（用于点卡片，不必模拟完整鼠标序列） */
    simulateClickSync(element) {
      if (!element) return;
      try {
        element.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true })
        );
        element.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true })
        );
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
      } catch (e) {
        try {
          element.click();
        } catch (e2) {}
      }
    },
 
    async handleChatPage() {
      const latestChatLi = await this.waitForElement(this.getLatestChatLi);
      if (!latestChatLi) return;
 
      const nameEl = latestChatLi.querySelector(".name-text");
      const companyEl = latestChatLi.querySelector(
        ".name-box span:nth-child(2)"
      );
      const name = (nameEl?.textContent || "未知").trim();
      const company = (companyEl?.textContent || "").trim();
      const hrKey = `${name}-${company}`.toLowerCase();
 
      // 如果当前正在监控同一个 HR，且 observer 正常，则跳过繁重逻辑
      if (this.currentMonitoredHR === hrKey && this.messageObserver) {
        return;
      }
 
      this.currentMonitoredHR = hrKey;
      this.resetMessageState();
 
      if (this.messageObserver) {
        this.messageObserver.disconnect();
        this.messageObserver = null;
      }
 
      if (
        settings.communicationIncludeKeywords &&
        settings.communicationIncludeKeywords.trim()
      ) {
        await this.simulateClick(latestChatLi.querySelector(".figure"));
        await this.delay(CONFIG.OPERATION_INTERVAL * 2);
 
        const positionName = this.getPositionName();
        const includeKeywords = settings.communicationIncludeKeywords
          .toLowerCase()
          .split(/[，,]/)
          .map((kw) => kw.trim())
          .filter((kw) => kw.length > 0);
 
        const positionNameLower = positionName.toLowerCase();
        const isMatch = includeKeywords.some((keyword) =>
          positionNameLower.includes(keyword)
        );
 
        if (!isMatch) {
          this.log(`跳过岗位，不含关键词[${includeKeywords.join(", ")}]`);
 
          if (settings.communicationMode === "auto") {
            await this.scrollUserList();
          }
          return;
        }
      }
 
      if (!latestChatLi.classList.contains("last-clicked")) {
        await this.simulateClick(latestChatLi.querySelector(".figure"));
        latestChatLi.classList.add("last-clicked");
 
        await this.delay(CONFIG.OPERATION_INTERVAL);
        await HRInteractionManager.handleHRInteraction(hrKey);
 
        if (settings.communicationMode === "auto") {
          await this.scrollUserList();
        }
      }
 
      await this.setupMessageObserver(hrKey);
    },
 
    async scrollUserList() {
      const userListContent = document.querySelector(".user-list-content");
      if (userListContent) {
        const totalHeight = userListContent.scrollHeight;
        const clientHeight = userListContent.clientHeight;
        const maxScrollTop = totalHeight - clientHeight;
 
        if (maxScrollTop <= 0) {
          return;
        }
 
        const scrollSteps = Math.floor(Math.random() * 3) + 3;
 
        for (let i = 0; i < scrollSteps; i++) {
          const randomTop = Math.floor(Math.random() * maxScrollTop);
 
          userListContent.scrollTo({
            top: randomTop,
            behavior: "smooth",
          });
 
          const randomDelay = Math.floor(Math.random() * 2000) + 1000;
          await this.delay(randomDelay);
        }
 
        const finalPosition = Math.random() > 0.5 ? maxScrollTop : 0;
        userListContent.scrollTo({
          top: finalPosition,
          behavior: "smooth",
        });
      }
    },
 
    resetMessageState() {
      this.lastProcessedMessage = null;
      this.processingMessage = false;
    },
 
    async setupMessageObserver(hrKey) {
      const chatContainer = await this.waitForElement(".chat-message .im-list");
      if (!chatContainer) return;
 
      this.messageObserver = new MutationObserver(async (mutations) => {
        let hasNewFriendMessage = false;
        for (const mutation of mutations) {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            hasNewFriendMessage = Array.from(mutation.addedNodes).some((node) =>
              node.classList?.contains("item-friend")
            );
            if (hasNewFriendMessage) break;
          }
        }
 
        if (hasNewFriendMessage) {
          await this.handleNewMessage(hrKey);
        }
      });
 
      this.messageObserver.observe(chatContainer, {
        childList: true,
        subtree: true,
      });
    },
 
    async handleNewMessage(hrKey) {
      if (!state.isRunning) return;
      if (this.processingMessage) return;
 
      this.processingMessage = true;
 
      try {
        await this.delay(CONFIG.OPERATION_INTERVAL);
 
        const lastMessage = await this.getLastFriendMessageText();
        if (!lastMessage) return;
 
        const cleanedMessage = this.cleanMessage(lastMessage);
        const shouldSendResumeOnly = cleanedMessage.includes("简历");
 
        if (cleanedMessage === this.lastProcessedMessage) return;
 
        this.lastProcessedMessage = cleanedMessage;
        this.log(`已同意交换，对方: ${lastMessage}`);
 
        await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
        const updatedMessage = await this.getLastFriendMessageText();
        if (
          updatedMessage &&
          this.cleanMessage(updatedMessage) !== cleanedMessage
        ) {
          await this.handleNewMessage(hrKey);
          return;
        }
 
        const autoSendResume = settings.useAutoSendResume;
        const autoReplyEnabled = settings.autoReply;
 
        if (shouldSendResumeOnly && autoSendResume) {
          this.log('对方提到"简历"，正在发送简历');
          const sent = await HRInteractionManager.sendResume();
          if (sent) {
            state.hrInteractions.sentResumeHRs.add(hrKey);
            StatePersistence.saveState();
            this.log(`已向 ${hrKey} 发送简历`);
          }
        } else if (autoReplyEnabled) {
          await HRInteractionManager.handleHRInteraction(hrKey);
        }
 
        await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
      } catch (error) {
        this.log(`处理消息出错: ${error.message}`);
      } finally {
        this.processingMessage = false;
      }
    },
 
    cleanMessage(message) {
      if (!message) return "";
 
      let clean = message.replace(/<[^>]*>/g, "");
      clean = clean
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[\u200B-\u200D\uFEFF]/g, "");
      return clean;
    },
 
    getLatestChatLi() {
      return document.querySelector(
        'ul[role="group"] li[role="listitem"][class]:has(.friend-content-warp)'
      );
    },
 
    /** 抓取当前详情区的职位信息（标题 / 岗位要求 / 技能标签） */
    extractJobDetail() {
      try {
        const title = this.getPositionName() || state.currentJobTitle || "";
        let description = "";
        const descSelectors = [
          ".job-detail-box .job-sec-text",
          ".job-detail-section .job-sec-text",
          ".job-sec-text",
          ".job-detail-box .text",
        ];
        for (const sel of descSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            description = el.textContent.trim();
            break;
          }
        }
        const tags = document.querySelectorAll(
          ".job-tag-box .tag-item, .job-tags .tag-item, .job-keyword-list .tag-item"
        );
        const skills = tags.length
          ? Array.from(tags)
              .map((x) => x.textContent.trim())
              .filter(Boolean)
              .join("、")
          : "";

        return {
          title: title,
          description: [description, skills ? "技能：" + skills : ""]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (e) {
        return { title: this.getPositionName() || "", description: "" };
      }
    },

    /**
     * 生成 AI 招呼语。
     * v2.1.0：提示词更明确，失败时给出可操作的原因；不再静默返回空串。
     */
    async generateGreeting(jobInfo) {
      if (!settings.aiApiKey) {
        this.log("请先在「设置 → AI 设置」中配置 API Key");
        return "";
      }
      if (!settings.resume || !settings.resume.trim()) {
        this.log("请先在「设置 → AI 设置」中填写「个人简历」，AI 才能生成针对性招呼语");
        return "";
      }
      if (!jobInfo || !jobInfo.title) {
        this.log("请先点击一个职位卡片，再生成招呼语");
        return "";
      }

      let selfIntro = "";
      const list = (state.settings.greetingsList || [])
        .map((g) => (g.content || "").trim())
        .filter(Boolean);
      if (list.length) {
        selfIntro = "自我介绍：\n" + list.join("\n") + "\n\n";
      }

      const defaultTpl =
        "根据以下信息，写 3-5 条投递给 HR 的打招呼消息。\n" +
        "要求：每条 20-100 字，口语化像真人聊天，突出与岗位匹配的技能/经历，表达对岗位的兴趣，最后询问是否方便发简历。\n" +
        "只输出消息正文，用换行分隔，不要编号、不要任何解释。\n\n" +
        "我的简历：{resume}\n" +
        "目标岗位：{job_title}\n" +
        "岗位要求：{job_requirements}";

      const tpl = settings.greetingTemplate || defaultTpl;
      const prompt = selfIntro +
        tpl
          .replace(/{resume}/g, settings.resume || "")
          .replace(/{job_title}/g, jobInfo.title || "")
          .replace(/{job_requirements}/g, jobInfo.description || "");

      const systemRole =
        "你是求职者在 BOSS 直聘上给 HR 发第一条消息。要求：先简洁自我介绍（学历/专业/年限），" +
        "再说明与岗位匹配的技能与成果，表达岗位意向，最后询问能否发一份简历。" +
        "语气礼貌自然、像真人聊天，不要客套废话，不要任何解释或前后缀。";

      try {
        this.log("正在调用 AI 生成招呼语…");
        const txt = await this.requestAi(prompt, systemRole);
        if (txt) {
          state.currentGeneratedGreeting = txt;
          const pv = document.getElementById("greeting-preview-text");
          if (pv) pv.value = txt;
          const ps = document.getElementById("greeting-preview-section");
          if (ps) ps.style.display = "block";
          this.log("招呼语生成成功，可编辑后点击「一键投递」");
          return txt;
        }
        this.log("AI 返回内容为空，请检查模型配置");
        return "";
      } catch (e) {
        this.log("AI 生成失败：" + e.message);
        if (typeof showNotification === "function") {
          showNotification("AI 生成失败：" + e.message, "error");
        }
        return "";
      }
    },
updateGreetingPreview(text){var pv=document.getElementById("greeting-preview-text");if(pv)pv.value=text;},
    getPositionName() {
      try {
        const positionNameElement =
          Core.getCachedElement(".position-name", true) ||
          Core.getCachedElement(".job-name", true) ||
          Core.getCachedElement(
            '[class*="position-content"] .left-content .position-name',
            true
          ) ||
          document.querySelector(".position-name") ||
          document.querySelector(".job-name");
 
        if (positionNameElement) {
          return positionNameElement.textContent.trim();
        } else {
          // Silent failure is better here as we might check multiple times
          return "";
        }
      } catch (e) {
        Core.log(`获取岗位名称出错: ${e.message}`);
        return "";
      }
    },
 
    async aiReply() {
      if (!state.isRunning) return;
      try {
        const autoReplyEnabled = JSON.parse(
          localStorage.getItem("autoReply") || "false"
        );
        if (!autoReplyEnabled) {
          return false;
        }
 
        const lastMessage = await this.getLastFriendMessageText();
        if (!lastMessage) return false;
 
        const today = new Date().toISOString().split("T")[0];
        if (state.ai.lastAiDate !== today) {
          state.ai.replyCount = 0;
          state.ai.lastAiDate = today;
          StatePersistence.saveState();
        }
 
        const maxReplies = 10;
        if (state.ai.replyCount >= maxReplies) {
          this.log(`AI回复已达上限`);
          return false;
        }
 
        const aiReplyText = await this.requestAi(lastMessage);
        if (!aiReplyText) return false;
 
        this.log(`AI回复: ${aiReplyText.slice(0, 30)}...`);
        state.ai.replyCount++;
        StatePersistence.saveState();
 
        const inputBox = await this.waitForElement("#chat-input");
        if (!inputBox) return false;
 
        inputBox.textContent = "";
        inputBox.focus();
        document.execCommand("insertText", false, aiReplyText);
        await this.delay(CONFIG.OPERATION_INTERVAL / 10);
 
        const sendButton = DOMCache.get(".btn-send");
        if (sendButton) {
          await this.simulateClick(sendButton);
        } else {
          const enterKeyEvent = new KeyboardEvent("keydown", {
            key: "Enter",
            keyCode: 13,
            code: "Enter",
            which: 13,
            bubbles: true,
          });
          inputBox.dispatchEvent(enterKeyEvent);
        }
 
        return true;
      } catch (error) {
        ErrorHandler.handle(error, 'Core.aiReply');
        this.log(`AI回复出错: ${error.message}`);
        return false;
      }
    },
 
    /**
     * 调用兼容 OpenAI 协议的对话接口。
     * v2.1.0 修复：
     *   - 旧版 system 提示词写成 localStorage.getItem("aiRole") || systemRole || ...，
     *     导致传入的 systemRole 永远被覆盖，生成招呼语时用的是"聊天回复"的角色设定；
     *   - 增加超时、失败重试与可读的错误信息（401/402/429 等）。
     */
    async requestAi(message, systemRole, options) {
      const opts = options || {};
      const retries = opts.retries === undefined ? 2 : opts.retries;
      const authToken = settings.aiApiKey || "";
      const apiUrl =
        settings.aiApiUrl || "https://api.deepseek.com/v1/chat/completions";

      if (!apiUrl) throw new Error("未配置 API 地址");

      // 角色优先级：显式传入的 systemRole > AI 角色定位（设置里的"AI角色定位"）
      const systemContent =
        systemRole || settings.aiRole || "你是求职者，用口语化表达，言简意赅。";

      const requestBody = {
        model: settings.aiModel || "deepseek-chat",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: message },
        ],
        temperature: 0.9,
        top_p: 0.8,
        max_tokens: 512,
        stream: false,
      };

      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          this.log(`AI 请求失败，${CONFIG.API.RETRY_DELAY}ms 后重试（${attempt}/${retries}）`);
          await this.delay(CONFIG.API.RETRY_DELAY);
        }
        try {
          const text = await this._doRequest(apiUrl, authToken, requestBody);
          if (text) return text;
        } catch (e) {
          lastError = e;
          // 鉴权/额度类错误重试无意义，直接抛出
          if (/401|403|402|余额|额度|无效|Unauthorized/i.test(e.message)) break;
        }
      }
      throw lastError || new Error("AI 请求失败");
    },

    _doRequest(apiUrl, authToken, requestBody) {
      return new Promise((resolve, reject) => {
        const finish = (fn, arg) => {
          try {
            fn(arg);
          } catch (e) {
            console.error(e);
          }
        };

        if (typeof GM_xmlhttpRequest !== "function") {
          return reject(
            new Error("当前脚本管理器未授予跨域请求权限（GM_xmlhttpRequest）")
          );
        }

        GM_xmlhttpRequest({
          method: "POST",
          url: apiUrl,
          timeout: CONFIG.API.TIMEOUT,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + (authToken || ""),
          },
          data: JSON.stringify(requestBody),
          onload: (response) => {
            const status = response.status;
            const body = response.responseText || "";

            // 解析响应
            let result = null;
            try {
              result = JSON.parse(body);
            } catch (e) {
              return finish(
                reject,
                new Error(
                  `接口返回了非 JSON 内容（HTTP ${status}）：${body.slice(0, 120)}`
                )
              );
            }

            // 兼容 OpenAI 格式与部分中转站的 {code,message} 格式
            const choice =
              result &&
              (result.choices && result.choices[0]) ||
              (result.data && result.data.choices && result.data.choices[0]);

            if (choice && choice.message && choice.message.content) {
              return finish(resolve, String(choice.message.content).trim());
            }

            if (status < 200 || status >= 300) {
              const msg =
                (result && (result.error?.message || result.message)) ||
                `HTTP ${status}`;
              return finish(reject, new Error(msg));
            }
            if (result && result.code !== undefined && result.code !== 0) {
              return finish(
                reject,
                new Error(
                  `${result.message || "接口返回错误"}（code: ${result.code}）`
                )
              );
            }

            return finish(
              reject,
              new Error("无法识别的接口返回格式：" + body.slice(0, 160))
            );
          },
          onerror: () =>
            finish(reject, new Error("网络请求失败，请检查 API 地址与网络")),
          ontimeout: () =>
            finish(
              reject,
              new Error(`请求超时（${CONFIG.API.TIMEOUT / 1000}s）`)
            ),
        });
      });
    },

    async getLastFriendMessageText() {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) return null;
 
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) return null;
 
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const textEl = lastMessageEl.querySelector(".text span");
        return textEl?.textContent?.trim() || null;
      } catch (error) {
        ErrorHandler.handle(error, 'Core.getLastFriendMessageText');
        this.log(`获取消息出错: ${error.message}`);
        return null;
      }
    },
 
    async simulateClick(element) {
      if (!element) return;
 
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
 
      const dispatchMouseEvent = (type, options = {}) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: document.defaultView,
          clientX: x,
          clientY: y,
          ...options,
        });
        element.dispatchEvent(event);
      };
 
      dispatchMouseEvent("mouseover");
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mousemove");
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mousedown", { button: 0 });
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mouseup", { button: 0 });
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("click", { button: 0 });
    },
 
    async waitForElement(selectorOrFunction, timeout = 5000) {
      return new Promise((resolve) => {
        let element;
        if (typeof selectorOrFunction === "function")
          element = selectorOrFunction();
        else element = document.querySelector(selectorOrFunction);
 
        if (element) return resolve(element);
 
        const timeoutId = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
        const observer = new MutationObserver(() => {
          if (typeof selectorOrFunction === "function")
            element = selectorOrFunction();
          else element = document.querySelector(selectorOrFunction);
          if (element) {
            clearTimeout(timeoutId);
            observer.disconnect();
            resolve(element);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    },
 
    getContextMultiplier(context) {
      const multipliers = {
        dict_load: 1.0,
        click: 0.8,
        selection: 0.8,
        default: 1.0,
      };
      return multipliers[context] || multipliers["default"];
    },
 
    async smartDelay(baseTime, context = "default") {
      const multiplier = this.getContextMultiplier(context);
      const adjustedTime = baseTime * multiplier;
      return this.delay(adjustedTime);
    },
 
    async delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
 
    async handleGreetSettingsPage() {
      try {
        localStorage.setItem(STORAGE.VISITED_GREET_SET, "true");
 
        await this.delay(1000);
 
        const titleElement = document.querySelector("h3.title-wrap");
 
        if (titleElement) {
          titleElement.textContent = "请务必打开 打招呼语功能";
          titleElement.style.color = "red";
          titleElement.style.fontWeight = "bold";
          titleElement.style.fontSize = "18px";
        }
 
        const possibleSelectors = [
          "h4 .ui-switch",
          ".ui-switch",
          "span.ui-switch",
          "[class*='ui-switch']"
        ];
 
        let switchElement = null;
        for (const selector of possibleSelectors) {
          switchElement = document.querySelector(selector);
          if (switchElement) {
            break;
          }
        }
 
        if (switchElement) {
          const isChecked = switchElement.classList.contains("ui-switch-checked");
          if (!isChecked) {
            await this.simulateClick(switchElement);
            await this.delay(800);
 
            const newSwitchElement = document.querySelector(possibleSelectors.find(s => document.querySelector(s)));
            if (newSwitchElement && newSwitchElement.classList.contains("ui-switch-checked")) {
              UI.notify("招呼语功能已启用", "success");
            } else {
              await this.simulateClick(switchElement);
              await this.delay(500);
 
              const finalSwitchElement = document.querySelector(possibleSelectors.find(s => document.querySelector(s)));
              if (finalSwitchElement && finalSwitchElement.classList.contains("ui-switch-checked")) {
                UI.notify("招呼语功能已启用", "success");
              } else {
                UI.notify("请手动启用招呼语功能", "warning");
              }
            }
          } else {
            UI.notify("招呼语功能已启用", "success");
          }
        } else {
          const allSwitches = document.querySelectorAll("[class*='switch']");
          allSwitches.forEach((el, index) => {
            this.log(`开关 ${index + 1}: ${el.className}, 文本: ${el.textContent?.trim()}`);
          });
        }
      } catch (error) {
        ErrorHandler.handle(error, 'Core.handleGreetSettingsPage');
      }
    },
 
    extractTwoCharKeywords(text) {
      const keywords = [];
      const cleanedText = text.replace(/[\s,，.。:：;；""''\[\]\(\)\{\}]/g, "");
 
      for (let i = 0; i < cleanedText.length - 1; i++) {
        keywords.push(cleanedText.substring(i, i + 2));
      }
 
      return keywords;
    },
 
    resetCycle() {
      toggleProcess();
      this.log("所有岗位沟通完成，恭喜您即将找到理想工作！");
      state.currentIndex = 0;
    },
 
    log(message) {
      const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
      const logPanel = document.querySelector("#pro-log");
      if (logPanel) {
        if (state.comments.isCommentMode) {
          return;
        }
 
        const logItem = document.createElement("div");
        logItem.className = "log-item";
        logItem.style.padding = "0px 8px";
        logItem.textContent = logEntry;
        logPanel.appendChild(logItem);
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    },
 

 

 

 

 

 

 

 

  };
 
  function toggleProcess() {
    state.isRunning = !state.isRunning;

    if (state.isRunning) {
      state.comments.isCommentMode = false;
      state.jobList = [];

      // 读取面板上的筛选条件
      state.includeKeywords = splitKeywords(
        elements.includeInput ? elements.includeInput.value : ""
      );
      state.locationKeywords = splitKeywords(
        elements.locationInput ? elements.locationInput.value : ""
      );
      settings.includeKeywords = state.includeKeywords;
      settings.locationKeywords = state.locationKeywords;

      // 保存筛选条件，下次打开不用重填（旧版刷新即丢）
      debouncedSaveSettings();

      if (elements.controlBtn) {
        elements.controlBtn.textContent = "停止";
        elements.controlBtn.style.background = "#ef4444";
      }

      const logPanel = document.querySelector("#pro-log");
      if (logPanel) logPanel.innerHTML = "";

      const startTime = new Date();
      Core.log(`开始运行，时间：${startTime.toLocaleTimeString()}`);
      Core.log(
        `筛选条件：职位名包含【${state.includeKeywords.join("、") || "无"}】，工作地包含【${state.locationKeywords.join("、") || "无"}】`
      );

      // AI 半自动模式下，若已选中某个职位并生成过招呼语 → 只投递这一个
      const preview = document.getElementById("greeting-preview-text");
      const previewText = preview ? (preview.value || "").trim() : "";
      const selectedCard = settings.aiGreetingEnabled
        ? Core.getSelectedCard()
        : null;

      if (settings.aiGreetingEnabled && selectedCard && previewText) {
        Core.log("AI 半自动模式：正在投递当前预览的职位…");
        (async () => {
          try {
            const info = Core.extractJobDetail();
            const title = (info && info.title) || state.currentJobTitle || "当前职位";
            const btn = await Core.waitForElement(() => Core.findChatButton(), 6000);
            if (!btn) {
              Core.log(`未找到「立即沟通」按钮，请先点击职位卡片打开详情`);
            } else {
              const ok = await Core.applyToJob(selectedCard, btn, title, previewText);
              if (ok) {
                state.stats.greeted++;
                refreshStatsUI();
                Core.log(`已向「${title}」发起沟通`);
              } else {
                state.stats.failed++;
                refreshStatsUI();
                Core.log(`投递「${title}」未确认成功，请检查页面状态`);
              }
            }
          } catch (e) {
            Core.log(`投递出错：${e.message}`);
          } finally {
            state.isRunning = false;
            if (elements.controlBtn) {
              elements.controlBtn.textContent = "🚀 一键投递";
              elements.controlBtn.style.background = "var(--primary-color)";
            }
          }
        })();
        return;
      }

      Core.startProcessing();
    } else {
      if (elements.controlBtn) {
        elements.controlBtn.textContent = settings.aiGreetingEnabled
          ? "🚀 一键投递"
          : "▶ 启动海投";
        elements.controlBtn.style.background = "var(--primary-color)";
      }

      state.isRunning = false;
      state.currentIndex = 0;
      if (typeof Core.stopAutoScroll === "function") {
        try {
          Core.stopAutoScroll();
        } catch (e) {}
      }
    }
  }
 
  function toggleChatProcess() {
    state.isRunning = !state.isRunning;
 
    if (state.isRunning) {
      elements.controlBtn.textContent = "停止智能聊天";
      elements.controlBtn.style.background = "#34a853";
 
      const startTime = new Date();
      Core.log(`开始智能聊天，时间：${startTime.toLocaleTimeString()}`);
 
      Core.startProcessing();
    } else {
      elements.controlBtn.textContent = "开始智能聊天";
      elements.controlBtn.style.background = "#34a853";
 
      state.isRunning = false;
 
      if (Core.messageObserver) {
        Core.messageObserver.disconnect();
        Core.messageObserver = null;
      }
 
      const stopTime = new Date();
      Core.log(`停止智能聊天，时间：${stopTime.toLocaleTimeString()}`);
    }
  }
 
  const STORAGE = {
    LETTER: "letterLastShown",
    GUIDE: "shouldShowGuide",
    AI_COUNT: "aiReplyCount",
    AI_DATE: "lastAiDate",
    VISITED_GREET_SET: "hasVisitedGreetSet",
  };
 
  const letter = {
    showLetterToUser: function () {
      const COLORS = {
        primary: "#4F46E5",
        text: "#333",
        textLight: "#666",
        background: "#f8f9fa",
      };
 
      const overlay = document.createElement("div");
      overlay.id = "letter-overlay";
      overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2147483647;
            backdrop-filter: blur(5px);
            animation: fadeIn 0.3s ease-out;
        `;

      // v2.1.0：加一个关闭按钮，用户不想看信时可以直接关掉
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "✕";
      closeBtn.title = "关闭";
      closeBtn.style.cssText = `
            position: absolute;
            top: 24px;
            right: 28px;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: none;
            background: rgba(255,255,255,0.2);
            color: #fff;
            font-size: 18px;
            cursor: pointer;
            z-index: 10;
        `;
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      });
      overlay.appendChild(closeBtn);
 
      const envelopeContainer = document.createElement("div");
      envelopeContainer.id = "envelope-container";
      envelopeContainer.style.cssText = `
            position: relative;
            width: 90%;
            max-width: 650px;
            height: 400px;
            perspective: 1000px;
        `;
 
      const envelope = document.createElement("div");
      envelope.id = "envelope";
      envelope.style.cssText = `
            position: absolute;
            width: 100%;
            height: 100%;
            transform-style: preserve-3d;
            transition: transform 0.6s ease;
        `;
 
      const envelopeBack = document.createElement("div");
      envelopeBack.id = "envelope-back";
      envelopeBack.style.cssText = `
            position: absolute;
            width: 100%;
            height: 100%;
            background: ${COLORS.background};
            border-radius: 10px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.2);
            backface-visibility: hidden;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 30px;
            cursor: pointer;
            transition: all 0.3s;
        `;
      envelopeBack.innerHTML = `
            <div style="font-size:clamp(1.5rem, 3vw, 1.8rem);font-weight:600;color:${COLORS.primary};margin-bottom:10px;">
                <i class="fa fa-envelope-o mr-2"></i>致海投用户的一封信
            </div>
            <div style="font-size:clamp(1rem, 2vw, 1.1rem);color:${COLORS.textLight};text-align:center;">
                点击开启高效求职之旅
            </div>
            <div style="position:absolute;bottom:20px;font-size:0.85rem;color:#999;">
                © ${new Date().getFullYear()} BOSS海投助手 | Zion Cai 版权所有
            </div>
        `;
 
      envelopeBack.addEventListener("click", () => {
        envelope.style.transform = "rotateY(180deg)";
        setTimeout(() => {
          const content = document.getElementById("letter-content");
          if (content) {
            content.style.display = "block";
            content.style.animation = "fadeInUp 0.5s ease-out forwards";
          }
        }, 300);
      });
 
      const envelopeFront = document.createElement("div");
      envelopeFront.id = "envelope-front";
      envelopeFront.style.cssText = `
            position: absolute;
            width: 100%;
            height: 100%;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.2);
            transform: rotateY(180deg);
            backface-visibility: hidden;
            display: flex;
            flex-direction: column;
        `;
 
      const titleBar = document.createElement("div");
      titleBar.style.cssText = `
            padding: 20px 30px;
            background: #4F46E5;
            color: white;
            font-size: clamp(1.2rem, 2.5vw, 1.4rem);
            font-weight: 600;
            border-radius: 10px 10px 0 0;
            display: flex;
            align-items: center;
        `;
      titleBar.innerHTML = `<i class="fa fa-envelope-open-o mr-2"></i>致海投助手用户：`;
 
      const letterContent = document.createElement("div");
      letterContent.id = "letter-content";
      letterContent.style.cssText = `
            flex: 1;
            padding: 25px 30px;
            overflow-y: auto;
            font-size: clamp(0.95rem, 2vw, 1.05rem);
            line-height: 1.8;
            color: ${COLORS.text};
 
            background-blend-mode: overlay;
            background-color: rgba(255,255,255,0.95);
            display: none;
        `;
      letterContent.innerHTML = `
            <div style="margin-bottom:20px;">
                <p>展信佳。</p>
                <p class="mt-2">&emsp;&emsp;正在困扰于实习面试的朋友：</p>
                <p class="mt-2">&emsp;&emsp;你好。</p>
                <p class="mt-3">
                    &emsp;&emsp;我也许和你一样，是在求职路上奔波的学生。经历过简历石沉大海、面试大脑空白的时刻，也懂得发出消息却无人回应的焦虑。这些重复与内耗，我深有体会。
                </p>
                <p class="mt-3">
                    &emsp;&emsp;正因如此，我用Claude Code做出了这个小工具。它不替代你的努力，只愿帮你节省时间，让你更专注于真正重要的事。它或许可以为你做这些：
                </p>
                <ul class="mt-3 ml-6 list-disc" style="text-indent:0;">
                    <li>&emsp;&emsp;自动沟通页面岗位，一键打招呼</li>
                    <li>&emsp;&emsp;AI智能生成契合岗位的招呼语，让每一次沟通都更有温度</li>
                    <li>&emsp;&emsp;个性化沟通策略，让HR更愿意回应你</li>
                </ul>
                <p class="mt-3">
                    &emsp;&emsp;希望这个工具帮你省下重复操作的时间，去专注真正重要的事。求职如长跑，保持节奏比冲刺更关键。愿你方向清晰，步履从容，最终抵达的不仅是理想岗位，更是更坚定、更舒展的自己。
                </p>
                <p class="mt-2">
                    &emsp;&emsp;祝前行有光，脚下有路。
                </p>
            </div>
            <div style="text-align:right;color:${COLORS.textLight};text-indent:0;">
                你的伙伴<br>
                ZionCai<br>
                2026年6月于西安
            </div>
        `;
 
      const buttonArea = document.createElement("div");
      buttonArea.style.cssText = `
            padding: 15px 30px;
            display: flex;
            justify-content: center;
            border-top: 1px solid #eee;
            background: ${COLORS.background};
            border-radius: 0 0 10px 10px;
        `;
 
      const startButton = document.createElement("button");
      startButton.style.cssText = `
            background: #4F46E5;
            color: white;
            border: none;
            border-radius: 8px;
            padding: 12px 30px;
            font-size: clamp(1rem, 2vw, 1.1rem);
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s;
            box-shadow: 0 6px 16px rgba(79, 70, 229, 0.3);
            outline: none;
            display: flex;
            align-items: center;
        `;
      startButton.innerHTML = `<i class="fa fa-rocket mr-2"></i>开始使用`;
 
      startButton.addEventListener("click", () => {
        const hasVisitedGreetSet = localStorage.getItem(STORAGE.VISITED_GREET_SET);
 
        if (!hasVisitedGreetSet) {
          localStorage.setItem(STORAGE.VISITED_GREET_SET, "true");
          window.open(
            "https://www.zhipin.com/web/geek/notify-set?type=greetSet",
            "_blank"
          );
        }
 
        envelopeContainer.style.animation = "scaleOut 0.3s ease-in forwards";
        overlay.style.animation = "fadeOut 0.3s ease-in forwards";
        setTimeout(() => {
          if (overlay.parentNode === document.body) {
            document.body.removeChild(overlay);
          }
        }, 300);
      });
 
      buttonArea.appendChild(startButton);
      envelopeFront.appendChild(titleBar);
      envelopeFront.appendChild(letterContent);
      envelopeFront.appendChild(buttonArea);
      envelope.appendChild(envelopeBack);
      envelope.appendChild(envelopeFront);
      envelopeContainer.appendChild(envelope);
      overlay.appendChild(envelopeContainer);
      document.body.appendChild(overlay);
 
      const style = document.createElement("style");
      style.textContent = `
            @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
            @keyframes fadeOut { from { opacity: 1 } to { opacity: 0 } }
            @keyframes scaleOut { from { transform: scale(1); opacity: 1 } to { transform: scale(.9); opacity: 0 } }
            @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px) } to { opacity: 1; transform: translateY(0) } }
 
            #envelope-back:hover { transform: scale(1.02); box-shadow: 0 20px 40px rgba(0,0,0,0.25); }
            #envelope-front button:hover { transform: scale(1.05); box-shadow: 0 8px 20px rgba(79, 70, 229, 0.4); }
            #envelope-front button:active { transform: scale(0.98); }
            
            @media (max-width: 480px) {
                #envelope-container { height: 350px; }
                #letter-content { font-size: 0.9rem; padding: 15px; }
            }
        `;
      document.head.appendChild(style);
    },
  };
 
  const guide = {
    steps: [
      {
        target: "div.city-label.active",
        content:
          '海投前，先在BOSS<span class="highlight">筛选出岗位</span>！\n\n助手会先滚动收集界面上显示的岗位，\n随后依次进行沟通~',
 
        arrowPosition: "bottom",
        defaultPosition: {
          left: "50%",
          top: "20%",
          transform: "translateX(-50%)",
        },
      },
      {
        target: 'a[ka="header-jobs"]',
        content:
          '<span class="highlight">职位页操作流程</span>：\n\n1. 扫描职位卡片\n2. 点击"立即沟通"（需开启"自动打招呼"）\n3. 留在当前页，继续沟通下一个职位\n\n全程无需手动干预，高效投递！',
 
        arrowPosition: "bottom",
        defaultPosition: { left: "25%", top: "80px" },
      },
      {
        target: 'a[ka="header-message"]',
        content:
          '<span class="highlight">海投建议</span>！\n\n• HR与您沟通，HR需要付费给平台\n因此您尽可能先自我介绍以提高效率 \n\n• HR查看附件简历，HR也要付费给平台\n所以尽量先发送`图片简历`给HR',
 
        arrowPosition: "left",
        defaultPosition: { right: "150px", top: "100px" },
      },
      {
        target: "div.logo",
        content:
          '<span class="highlight">您需要打开两个浏览器窗口</span>：\n\n左侧窗口自动打招呼发起沟通\n右侧发送自我介绍和图片简历\n\n您只需专注于挑选offer！',
 
        arrowPosition: "right",
        defaultPosition: { left: "200px", top: "20px" },
      },
      {
        target: "div.logo",
        content:
          '<span class="highlight">特别注意</span>：\n\n1. <span class="warning">BOSS直聘每日打招呼上限为150次</span>\n2. 聊天页仅处理最上方的最新对话\n3. 打招呼后对方会显示在聊天页\n4. <span class="warning">投递操作过于频繁有封号风险!</span>',
 
        arrowPosition: "bottom",
        defaultPosition: { left: "50px", top: "80px" },
      },
    ],
    currentStep: 0,
    guideElement: null,
    overlay: null,
    highlightElements: [],
 
    showGuideToUser() {
      this.overlay = document.createElement("div");
      this.overlay.id = "guide-overlay";
      this.overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(2px);
            z-index: 99997;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
      document.body.appendChild(this.overlay);
 
      this.guideElement = document.createElement("div");
      this.guideElement.id = "guide-tooltip";
      this.guideElement.style.cssText = `
            position: fixed;
            z-index: 99999;
            width: 320px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            overflow: hidden;
            opacity: 0;
            transform: translateY(10px);
            transition: opacity 0.3s ease, transform 0.3s ease;
        `;
      document.body.appendChild(this.guideElement);
 
      setTimeout(() => {
        this.overlay.style.opacity = "1";
 
        setTimeout(() => {
          this.showStep(0);
        }, 300);
      }, 100);
    },
 
    showStep(stepIndex) {
      const step = this.steps[stepIndex];
      if (!step) return;
 
      this.clearHighlights();
      const target = document.querySelector(step.target);
 
      if (target) {
        const rect = target.getBoundingClientRect();
        const highlight = document.createElement("div");
        highlight.className = "guide-highlight";
        highlight.style.cssText = `
                position: fixed;
                top: ${rect.top}px;
                left: ${rect.left}px;
                width: ${rect.width}px;
                height: ${rect.height}px;
                background: ${step.highlightColor || "#4F46E5"};
                opacity: 0.2;
                border-radius: 4px;
                z-index: 99998;
                box-shadow: 0 0 0 4px ${step.highlightColor || "#4F46E5"};
                animation: guide-pulse 2s infinite;
            `;
        document.body.appendChild(highlight);
        this.highlightElements.push(highlight);
 
        this.setGuidePositionFromTarget(step, rect);
      } else {
        console.warn("引导目标元素未找到，使用默认位置:", step.target);
 
        this.setGuidePositionFromDefault(step);
      }
 
      let buttonsHtml = "";
 
      if (stepIndex === this.steps.length - 1) {
        buttonsHtml = `
                <div class="guide-buttons" style="display: flex; justify-content: center; padding: 16px; border-top: 1px solid #f0f0f0; background: #f9fafb;">
                    <button id="guide-finish-btn" style="padding: 8px 32px; background: ${step.highlightColor || "#4F46E5"
          }; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);">
                        完成
                    </button>
                </div>
            `;
      } else {
        buttonsHtml = `
                <div class="guide-buttons" style="display: flex; justify-content: flex-end; padding: 16px; border-top: 1px solid #f0f0f0; background: #f9fafb;">
                    <button id="guide-skip-btn" style="padding: 8px 16px; background: white; color: #4b5563; border: 1px solid #e5e7eb; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;">跳过</button>
                    <button id="guide-next-btn" style="padding: 8px 16px; background: ${step.highlightColor || "#4F46E5"
          }; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin-left: 8px; transition: all 0.2s ease; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);">下一步</button>
                </div>
            `;
      }
 
      this.guideElement.innerHTML = `
            <div class="guide-header" style="padding: 16px; background: ${step.highlightColor || "#4F46E5"
        }; color: white;">
                <div class="guide-title" style="font-size: 16px; font-weight: 600;">海投助手引导</div>
                <div class="guide-step" style="font-size: 12px; opacity: 0.8; margin-top: 2px;">步骤 ${stepIndex + 1
        }/${this.steps.length}</div>
            </div>
            <div class="guide-content" style="padding: 20px; font-size: 14px; line-height: 1.6;">
                <div style="white-space: pre-wrap; font-family: inherit; margin: 0;">${step.content
        }</div>
            </div>
            ${buttonsHtml}
        `;
 
      if (stepIndex === this.steps.length - 1) {
        document
          .getElementById("guide-finish-btn")
          .addEventListener("click", () => this.endGuide(true));
      } else {
        document
          .getElementById("guide-next-btn")
          .addEventListener("click", () => this.nextStep());
        document
          .getElementById("guide-skip-btn")
          .addEventListener("click", () => this.endGuide());
      }
 
      if (stepIndex === this.steps.length - 1) {
        const finishBtn = document.getElementById("guide-finish-btn");
        finishBtn.addEventListener("mouseenter", () => {
          finishBtn.style.background = this.darkenColor(
            step.highlightColor || "#4F46E5",
            15
          );
          finishBtn.style.boxShadow =
            "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
        });
        finishBtn.addEventListener("mouseleave", () => {
          finishBtn.style.background = step.highlightColor || "#4F46E5";
          finishBtn.style.boxShadow =
            "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)";
        });
      } else {
        const nextBtn = document.getElementById("guide-next-btn");
        const skipBtn = document.getElementById("guide-skip-btn");
 
        nextBtn.addEventListener("mouseenter", () => {
          nextBtn.style.background = this.darkenColor(
            step.highlightColor || "#4F46E5",
            15
          );
          nextBtn.style.boxShadow =
            "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
        });
        nextBtn.addEventListener("mouseleave", () => {
          nextBtn.style.background = step.highlightColor || "#4F46E5";
          nextBtn.style.boxShadow =
            "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)";
        });
 
        skipBtn.addEventListener("mouseenter", () => {
          skipBtn.style.background = "#f3f4f6";
        });
        skipBtn.addEventListener("mouseleave", () => {
          skipBtn.style.background = "white";
        });
      }
 
      this.guideElement.style.opacity = "1";
      this.guideElement.style.transform = "translateY(0)";
    },
 
    setGuidePositionFromTarget(step, rect) {
      let left, top;
      const guideWidth = 320;
      const guideHeight = 240;
 
      switch (step.arrowPosition) {
        case "top":
          left = rect.left + rect.width / 2 - guideWidth / 2;
          top = rect.top - guideHeight - 20;
          break;
        case "bottom":
          left = rect.left + rect.width / 2 - guideWidth / 2;
          top = rect.bottom + 20;
          break;
        case "left":
          left = rect.left - guideWidth - 20;
          top = rect.top + rect.height / 2 - guideHeight / 2;
          break;
        case "right":
          left = rect.right + 20;
          top = rect.top + rect.height / 2 - guideHeight / 2;
          break;
        default:
          left = rect.right + 20;
          top = rect.top;
      }
 
      left = Math.max(10, Math.min(left, window.innerWidth - guideWidth - 10));
      top = Math.max(10, Math.min(top, window.innerHeight - guideHeight - 10));
 
      this.guideElement.style.left = `${left}px`;
      this.guideElement.style.top = `${top}px`;
      this.guideElement.style.transform = "translateY(0)";
    },
 
    setGuidePositionFromDefault(step) {
      const position = step.defaultPosition || {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
      };
 
      Object.assign(this.guideElement.style, {
        left: position.left,
        top: position.top,
        right: position.right || "auto",
        bottom: position.bottom || "auto",
        transform: position.transform || "none",
      });
    },
 
    nextStep() {
      const currentStep = this.steps[this.currentStep];
      if (currentStep) {
        const target = document.querySelector(currentStep.target);
        if (target) {
          target.removeEventListener("click", this.nextStep);
        }
      }
 
      this.currentStep++;
      if (this.currentStep < this.steps.length) {
        this.guideElement.style.opacity = "0";
        this.guideElement.style.transform = "translateY(10px)";
 
        setTimeout(() => {
          this.showStep(this.currentStep);
        }, 300);
      }
    },
 
    clearHighlights() {
      this.highlightElements.forEach((el) => el.remove());
      this.highlightElements = [];
    },
 
    endGuide(isCompleted = false) {
      this.clearHighlights();
 
      this.guideElement.style.opacity = "0";
      this.guideElement.style.transform = "translateY(10px)";
      this.overlay.style.opacity = "0";
 
      setTimeout(() => {
        if (this.overlay && this.overlay.parentNode) {
          this.overlay.parentNode.removeChild(this.overlay);
        }
        if (this.guideElement && this.guideElement.parentNode) {
          this.guideElement.parentNode.removeChild(this.guideElement);
        }
 
        if (isCompleted && this.chatUrl) {
          window.open(this.chatUrl, "_blank");
        }
      }, 300);
 
      document.dispatchEvent(new Event("guideEnd"));
    },
 
    darkenColor(color, percent) {
      let R = parseInt(color.substring(1, 3), 16);
      let G = parseInt(color.substring(3, 5), 16);
      let B = parseInt(color.substring(5, 7), 16);
 
      R = parseInt((R * (100 - percent)) / 100);
      G = parseInt((G * (100 - percent)) / 100);
      B = parseInt((B * (100 - percent)) / 100);
 
      R = R < 255 ? R : 255;
      G = G < 255 ? G : 255;
      B = B < 255 ? B : 255;
 
      R = Math.round(R);
      G = Math.round(G);
      B = Math.round(B);
 
      const RR =
        R.toString(16).length === 1 ? "0" + R.toString(16) : R.toString(16);
      const GG =
        G.toString(16).length === 1 ? "0" + G.toString(16) : G.toString(16);
      const BB =
        B.toString(16).length === 1 ? "0" + B.toString(16) : B.toString(16);
 
      return `#${RR}${GG}${BB}`;
    },
  };
 
  const style = document.createElement("style");
  style.textContent = `
    @keyframes guide-pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.4); }
        70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(79, 70, 229, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
    }
    
    .guide-content .highlight {
        font-weight: 700;
        color: #1a73e8;
    }
    
    .guide-content .warning {
        font-weight: 700;
        color: #d93025;
    }
`;
  document.head.appendChild(style);
 
  function getToday() {
    return new Date().toISOString().split("T")[0];
  }

  /** v2.1.0：把中英文逗号分隔的筛选词切成数组 */
  function splitKeywords(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .split(/[，,]/)
      .map((k) => k.trim())
      .filter((k) => k !== "");
  }

  /** 今日零点自动清理 AI 回复计数（每天重新计数） */
  function scheduleDailyAiReset() {
    try {
      const midnight = new Date();
      midnight.setDate(midnight.getDate() + 1);
      midnight.setHours(0, 0, 0, 0);
      const wait = midnight.getTime() - Date.now();
      if (wait <= 0 || wait > 24 * 60 * 60 * 1000) return;
      setTimeout(() => {
        try {
          localStorage.removeItem(STORAGE.AI_COUNT);
          localStorage.removeItem(STORAGE.AI_DATE);
        } catch (e) {}
      }, wait);
    } catch (e) {}
  }

  /** 等 document.body 可用，避免脚本注入过早导致面板挂不上 */
  function waitForBody(timeout = 15000) {
    return new Promise((resolve) => {
      if (document.body) return resolve(true);
      const start = Date.now();
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
  }

  async function init() {
    try {
      // 配置加载 + 页面识别（旧版从未调用 loadState，导致筛选条件、存储上限都失效）
      StatePersistence.loadState();
      APIInterceptor.init();
      scheduleDailyAiReset();

      const ok = await waitForBody();
      if (!ok || !document.body) {
        console.warn("[海投助手] 页面结构不可用，放弃注入");
        return;
      }

      UI.init();
      try {
        document.body.style.position = "relative";
      } catch (e) {}

      // 面板被 BOSS 的重新渲染顶掉时自动补挂
      startPanelWatchdog();

      const today = getToday();
      if (PAGE.isJobList()) {
        // 欢迎信只在首次安装（或版本升级）后出现一次，不再每天拦截用户
        const shownVersion = settings.letterShownVersion || "";
        if (shownVersion !== "2.1.0") {
          letter.showLetterToUser();
          settings.letterShownVersion = "2.1.0";
          saveSettings();
        } else if (localStorage.getItem(STORAGE.GUIDE) !== "true") {
          guide.showGuideToUser();
          localStorage.setItem(STORAGE.GUIDE, "true");
        }
        Core.log("欢迎使用海投助手，当前为" + (settings.aiGreetingEnabled ? "AI 半自动模式：点击职位卡片生成招呼语，确认后一键投递" : "全自动模式：点击「启动海投」批量沟通"));
      } else if (PAGE.isChat()) {
        Core.log("欢迎使用海投助手，我将自动发送简历！");
      } else if (PAGE.isGreetSettings()) {
        Core.log("欢迎使用海投助手，正在检测招呼语开关…");
        Core.handleGreetSettingsPage();
      } else {
        Core.log("当前页面暂不支持，请打开 BOSS 直聘职位列表页（www.zhipin.com/web/geek/jobs）");
      }
    } catch (error) {
      console.error("[海投助手] 初始化失败:", error);
      // 不再使用 alert 打断用户，改为页面内提示，并保证面板仍可用
      try {
        if (typeof showNotification === "function") {
          showNotification("海投助手初始化异常：" + error.message, "error");
        }
      } catch (e) {}
    }
  }

  /* ---------------- v2.1.0 新增：面板守护 & 单页路由切换 ---------------- */
  let panelWatchdogTimer = null;

  function startPanelWatchdog() {
    if (panelWatchdogTimer) return;
    panelWatchdogTimer = setInterval(() => {
      try {
        if (!document.body) return;
        if (!document.getElementById("boss-pro-panel")) {
          console.warn("[海投助手] 面板丢失，重新注入");
          UI.createControlPanel();
          if (!document.getElementById("boss-mini-icon") && !elements.miniIcon) {
            UI.createMiniIcon();
          }
        }
      } catch (e) {
        console.error("[海投助手] 面板守护异常:", e);
      }
    }, 3000);
  }

  let lastPageKey = PAGE.key();

  function handleRouteChange() {
    const key = PAGE.key();
    if (key === lastPageKey) return;
    lastPageKey = key;

    console.log("[海投助手] 页面切换到:", key);

    if (state.isRunning) {
      state.isRunning = false;
      state.currentIndex = 0;
      state.jobList = [];
      Core.log("页面已切换，已停止当前任务");
    }

    // BOSS 是单页应用，切换路由后旧面板内容不再适用，重建
    try {
      const oldPanel = document.getElementById("boss-pro-panel");
      if (oldPanel) oldPanel.remove();
      const oldMini = document.getElementById("boss-mini-icon");
      if (oldMini) oldMini.remove();
      elements.panel = null;
      elements.miniIcon = null;
      elements.controlBtn = null;
      Core.clearDomCache();
      UI.init();
    } catch (e) {
      console.error("[海投助手] 重建面板失败:", e);
    }
  }

  init();

  // 单页路由监听：同时监听 history 变化与 DOM 变化，双保险
  (function watchRoute() {
    ["pushState", "replaceState"].forEach((name) => {
      const orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function () {
        const ret = orig.apply(this, arguments);
        setTimeout(handleRouteChange, 60);
        return ret;
      };
    });
    window.addEventListener("popstate", () => setTimeout(handleRouteChange, 60));

    let lastHref = location.href;
    const mo = new MutationObserver(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        setTimeout(handleRouteChange, 60);
      }
    });
    if (document.documentElement) {
      mo.observe(document.documentElement, { subtree: true, childList: true });
    }
  })();

  function addGreetingItem() {
    if (!state.settings.greetingsList) {
      state.settings.greetingsList = [];
    }

    const hasEmpty = state.settings.greetingsList.some(
      (greeting) => !greeting.content.trim()
    );
 
    if (hasEmpty) {
      return;
    }
 
    const newGreeting = {
      id: Date.now().toString(),
      content: "",
    };
 
    state.settings.greetingsList.push(newGreeting);
    StatePersistence.saveState();
    renderGreetingsList();
  }
 
  function renderGreetingsList() {
    const greetingsList = document.getElementById("greetings-list");
    if (!greetingsList) return;
 
    greetingsList.innerHTML = "";
 
    if (
      !state.settings.greetingsList ||
      state.settings.greetingsList.length === 0
    ) {
      greetingsList.innerHTML =
        '<div style="color: #6b7280; text-align: center; padding: 20px;">暂无自我介绍内容</div>';
      return;
    }
 
    state.settings.greetingsList.forEach((greeting, index) => {
      const greetingElement = document.createElement("div");
      greetingElement.className = "greeting-item";
      greetingElement.style.cssText = `
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        padding: 6px;
        margin-bottom: 6px;
        background: #f9fafb;
      `;
 
      greetingElement.innerHTML = `
        <div style="display: flex; gap: 8px; align-items: center;">
          <span style="color: #6b7280; font-size: 12px; min-width: 20px;">${index + 1}.</span>
          <div style="flex: 1;">
            <input type="text" class="greeting-input" data-id="${greeting.id}" placeholder="输入自我介绍内容" style="
              width: 100%;
              padding: 4px 6px;
              border: 1px solid #d1d5db;
              border-radius: 3px;
              font-size: 13px;
            ">
          </div>
          <button class="delete-greeting-btn" data-id="${greeting.id}" style="
            padding: 3px 6px;
            border: 1px solid #ef4444;
            background: #fef2f2;
            color: #dc2626;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
            white-space: nowrap;
          ">删除</button>
        </div>
      `;
 
      greetingsList.appendChild(greetingElement);
    });
 
    attachGreetingEventListeners();
  }
 
  function attachGreetingEventListeners() {
    document.querySelectorAll(".delete-greeting-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const greetingId = e.target.dataset.id;
        state.settings.greetingsList = state.settings.greetingsList.filter(
          (g) => g.id !== greetingId
        );
        saveSettings();
        renderGreetingsList();
      });
    });

    document.querySelectorAll(".greeting-input").forEach((input) => {
      const greetingId = input.dataset.id;
      const greeting = (state.settings.greetingsList || []).find(
        (g) => g.id === greetingId
      );
      // 用 property 赋值，避免内容里的引号破坏 HTML（旧版用 value="..." 会截断）
      if (greeting) input.value = greeting.content || "";

      input.addEventListener("input", (e) => {
        const target = (state.settings.greetingsList || []).find(
          (g) => g.id === greetingId
        );
        if (target) {
          target.content = e.target.value;
          debouncedSaveSettings();
        }
      });
    });
  }

  /* =========================================================================
   * 简历文件解析（v2.1.0 修复：旧版直接对 .docx 做 UTF-8 文本搜索，
   * 但 .docx 本质是 ZIP 压缩包，所以旧版"Word 导入"实际上永远解析不出内容）
   * ========================================================================= */

  /** 用浏览器原生 DecompressionStream 解压（Chrome/Edge 80+ 支持） */
  async function inflateBytes(data, format) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持解压，请改用 .txt 或 .md 格式");
    }
    const ds = new DecompressionStream(format || "deflate-raw");
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 从 ZIP（docx）中取出指定文件的字节 */
  async function unzipEntry(buffer, targetName) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const utf8 = new TextDecoder("utf-8");

    // 从尾部向前找 End Of Central Directory
    let eocd = -1;
    const minPos = Math.max(0, u8.length - 22 - 65536);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("不是有效的 docx 文件（未找到 zip 结构）");

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);

    for (let i = 0; i < count && off + 46 <= u8.length; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = utf8.decode(u8.subarray(off + 46, off + 46 + nameLen));

      if (name === targetName) {
        const lnameLen = dv.getUint16(localOff + 26, true);
        const lextraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lnameLen + lextraLen;
        const data = u8.subarray(dataStart, dataStart + compSize);
        if (method === 0) return data;
        if (method === 8) return await inflateBytes(data, "deflate-raw");
        throw new Error("docx 使用了不支持的压缩方式：" + method);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error("docx 中未找到 " + targetName);
  }

  /** 解析 .docx：取出 word/document.xml 并还原为纯文本 */
  async function extractTextFromDocx(buffer) {
    const xml = new TextDecoder("utf-8").decode(
      await unzipEntry(buffer, "word/document.xml")
    );
    return xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  /** 从 PDF 的文本对象里抽字（尽力而为，复杂排版/CID 字体可能识别不全） */
  async function extractTextFromPdf(buffer) {
    const latin1 = new TextDecoder("latin1").decode(new Uint8Array(buffer));

    const decodePdfString = (s) =>
      s
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

    const collectFromContent = (content) => {
      const out = [];
      const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|'|")/g;
      let m;
      while ((m = re.exec(content))) out.push(decodePdfString(m[1]));
      const arrRe = /\[([^\]]*)\]\s*TJ/g;
      while ((m = arrRe.exec(content))) {
        const inner = m[1];
        const sRe = /\(((?:\\.|[^\\()])*)\)/g;
        let s;
        while ((s = sRe.exec(inner))) out.push(decodePdfString(s[1]));
        out.push("");
      }
      return out.join(" ").replace(/\s{2,}/g, " ");
    };

    let text = "";
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = streamRe.exec(latin1))) {
      const chunk = m[1];
      let content = chunk;
      if (!/BT[\s\S]*?ET/.test(chunk) && typeof DecompressionStream === "function") {
        try {
          const bytes = Uint8Array.from(chunk, (c) => c.charCodeAt(0) & 0xff);
          content = new TextDecoder("latin1").decode(
            await inflateBytes(bytes, "deflate")
          );
        } catch (e) {
          continue;
        }
      }
      if (/BT[\s\S]*?ET/.test(content)) text += collectFromContent(content) + "\n";
    }

    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 10) {
      throw new Error(
        "无法从该 PDF 提取文本（可能是扫描件或使用了特殊字体），请另存为 .docx / .txt 后导入"
      );
    }
    return text;
  }

  /** 输入时不必每敲一个字就写一次 localStorage */
  let saveSettingsTimer = null;
  function debouncedSaveSettings() {
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(() => {
      saveSettingsTimer = null;
      saveSettings();
    }, 400);
  }

  function loadGreetings() {
    if (!state.settings.greetingsList || state.settings.greetingsList.length === 0) {
      state.settings.greetingsList = [{ id: Date.now().toString(), content: "" }];
      saveSettings();
    }
    renderGreetingsList();
  }
})();
