(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  const TranslationSDK = {
    config: {
      apiUrl: API_URL,
      siteId: null,
      sourceLanguage: "en", // Original language
      targetLanguage: null,
      apiKey: null,
      autoTranslate: true,
      selectors: {
        include: [
          'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'li', 'td', 'th', 'button', 'a', 'label', 'span'
        ],
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },
    _translationRetries: 0,
    _languageSelectorButton: null,
    _mutationTimeout: null,
    _observer: null,
    _languageMapping: {
      en: 'Original',
      hi: 'हिन्दी (Hindi)',
      mr: 'मराठी (Marathi)',
      ta: 'தமிழ் (Tamil)',
      kn: 'ಕನ್ನಡ (Kannada)',
      pa: 'ਪੰਜਾਬੀ (Punjabi)',
      gu: 'ગુજરાતી (Gujarati)'
    },
    // LocalStorage keys:
    _originalContentKey: "translationSDK_originalContent",  // mapping: id -> { text, type, context }
    _cacheKey: "translationSDK_cache",                      // mapping: id-targetLanguage -> translated text
    
    _setupRouteChangeListener: function() {
      console.log("[Route] Setting up route change listener.");
      const _pushState = history.pushState;
      history.pushState = function () {
        _pushState.apply(history, arguments);
        window.dispatchEvent(new Event("locationchange"));
      };
      const _replaceState = history.replaceState;
      history.replaceState = function () {
        _replaceState.apply(history, arguments);
        window.dispatchEvent(new Event("locationchange"));
      };
      window.addEventListener("popstate", function () {
        window.dispatchEvent(new Event("locationchange"));
      });
      window.addEventListener("locationchange", () => {
        console.log("[Route] Route changed. Retrying translation...");
        setTimeout(() => {
          TranslationSDK.translatePage(TranslationSDK.config.targetLanguage);
        }, 500);
      });
    },

    /* ---------- Cache Helper Functions ---------- */
    _getCache: function() {
      console.log("[Cache] Retrieving cache from localStorage.");
      const stored = localStorage.getItem(this._cacheKey);
      try {
        const cache = stored ? JSON.parse(stored) : {};
        console.log("[Cache] Current cache:", cache);
        return cache;
      } catch(e) {
        console.error("[Cache] Error parsing cache:", e);
        return {};
      }
    },
    _setCache: function(cache) {
      console.log("[Cache] Saving cache to localStorage:", cache);
      localStorage.setItem(this._cacheKey, JSON.stringify(cache));
    },
    // Compute a stable MD5 hash with SparkMD5.
    _computeHash: function(str) {
      const computedHash = SparkMD5.hash(str);
      console.log("[Hash] Computed hash using SparkMD5:", computedHash);
      return computedHash;
    },
    /* -------------------------------------------- */

    // --- Step 2 & 3: Extract content, compute stable id, and build context ---
    extractContent: function() {
      console.log("[Extract] Extracting content using selectors.");
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));
      const excludeSelector = this.config.selectors.exclude.join(',');
      const excluded = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];
      const filtered = elements.filter(el =>
        !excluded.some(ex => ex.contains(el) || el.contains(ex))
      );
      console.log("[Extract] Found", filtered.length, "elements after filtering.");

      const extracted = filtered.map(el => {
        const originalText = el.textContent.trim();
        if (!originalText) return null;
        // Compute and set a stable id only once.
        let key = el.id;
        if (!key || key.length === 0) {
          key = "el-" + this._computeHash(originalText);
          el.id = key;
          console.log("[Extract] Assigned new id to element:", key);
        } else {
          console.log("[Extract] Using existing id for element:", key);
        }
        // Determine type based on tag.
        const tag = el.tagName.toLowerCase();
        let type = "other";
        if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
          type = "heading";
        } else if (tag === "p") {
          type = "paragraph";
        } else if (tag === "li") {
          type = "list-item";
        } else if (tag === "button") {
          type = "button";
        } else if (tag === "a") {
          type = "link";
        }
        // Build context from closest section and immediate siblings.
        const sectionEl = el.closest('section, article, div.section');
        const sectionTitle = sectionEl 
          ? (sectionEl.querySelector('h1, h2, h3')?.textContent.trim() || "")
          : "";
        const siblings = Array.from(el.parentNode.children);
        const index = siblings.indexOf(el);
        const preceding = (index > 0) ? siblings[index - 1].textContent.trim() : "";
        const following = (index < siblings.length - 1) ? siblings[index + 1].textContent.trim() : "";
        const context = {
          preceding: preceding,
          following: following,
          sectionTitle: sectionTitle
        };
        return {
          id: key,
          text: originalText,
          type: type,
          context: context,
          element: el
        };
      }).filter(item => item !== null);
      console.log("[Extract] Extracted", extracted.length, "content items.");
      return extracted;
    },

    // --- Step 4: Save original mapping (id -> {text, type, context}) in localStorage ---
    _saveOriginalContent: function() {
      console.log("[Original] Saving original content...");
      const content = this.extractContent();
      const mapping = {};
      content.forEach(item => {
        mapping[item.id] = {
          text: item.text,
          type: item.type,
          context: item.context
        };
      });
      localStorage.setItem(this._originalContentKey, JSON.stringify(mapping));
      console.log("[Original] Original content saved:", mapping);
    },

    // --- Helper: Retrieve original content mapping as an array ---
    _getOriginalContent: function() {
      console.log("[Original] Retrieving original content mapping.");
      const stored = localStorage.getItem(this._originalContentKey);
      if (!stored) {
        console.warn("[Original] No original content mapping found.");
        return [];
      }
      const mapping = JSON.parse(stored);
      const items = [];
      for (const key in mapping) {
        const el = document.getElementById(key);
        if (el) {
          items.push({
            id: key,
            text: mapping[key].text,
            type: mapping[key].type,
            context: mapping[key].context,
            element: el
          });
        }
      }
      console.log("[Original] Retrieved", items.length, "original content items.");
      return items;
    },

    // --- Step 10: Restore original content from localStorage ---
    _restoreOriginalContent: function() {
      console.log("[Restore] Restoring original content...");
      const mappingStr = localStorage.getItem(this._originalContentKey);
      if (!mappingStr) {
        console.warn("[Restore] No original content found.");
        return;
      }
      const mapping = JSON.parse(mappingStr);
      for (const key in mapping) {
        const el = document.getElementById(key);
        if (el) {
          el.textContent = mapping[key].text;
          Array.from(el.classList).forEach(cls => {
            if (cls.indexOf("translated-") === 0) {
              el.classList.remove(cls);
              console.log(`[Restore] Removed class ${cls} from element ${key}`);
            }
          });
          console.log(`[Restore] Restored element ${key}`);
        }
      }
      console.log("[Restore] Finished restoring original content.");
    },

    // --- Step 5: Main translation method ---
    translatePage: function(targetLanguage) {
      console.log(`[Translate] Translating page to: ${targetLanguage}`);
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);
      console.log("[Translate] Saved target language in localStorage:", targetLanguage);

      if (this._languageSelectorButton) {
        const name = this._languageMapping[targetLanguage] || targetLanguage;
        this._languageSelectorButton.innerHTML = `<span>🌐</span> <span>${name}</span>`;
        console.log("[Translate] Updated language selector to:", name);
      }

      // If target is the source language, restore original content.
      if (targetLanguage === this.config.sourceLanguage) {
        console.log("[Translate] Target language is source. Restoring original content.");
        this._restoreOriginalContent();
        return;
      }

      const originalItems = this._getOriginalContent();
      if (originalItems.length === 0 && this._translationRetries < 3) {
        this._translationRetries++;
        console.warn("[Translate] No original items found; retrying in 500ms. Retry count:", this._translationRetries);
        setTimeout(() => { this.translatePage(targetLanguage); }, 500);
        return;
      }
      this._translationRetries = 0;
      this._showLoadingIndicator();

      // Fetch translations for these original items.
      this._sendTranslationRequest(originalItems, (translations) => {
        console.log("[Translate] Received translations:", translations);
        this._applyTranslations(translations);
        this._hideLoadingIndicator();
      });
    },

    // --- Step 7 & 8: Send API request for missing translations; update cache ---
    _sendTranslationRequest: function(contentItems, callback) {
      console.log("[API] Starting translation request for", contentItems.length, "items.");
      const cache = this._getCache();
      const toRequest = [];
      const cachedResults = [];

      contentItems.forEach(item => {
        const cacheKey = item.id + "-" + this.config.targetLanguage;
        if (cache[cacheKey]) {
          console.log(`[API] Cache hit for ${item.id} using key ${cacheKey}`);
          cachedResults.push({ id: item.id, translated: cache[cacheKey] });
        } else {
          console.log(`[API] Cache miss for ${item.id} using key ${cacheKey}.`);
          toRequest.push(item);
        }
      });

      if (toRequest.length === 0) {
        console.log("[API] All translations found in cache.");
        callback(cachedResults);
        return;
      }

      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: toRequest.map(item => ({
          id: item.id,
          text: item.text,
          type: item.type,
          context: item.context
        }))
      };
      console.log("[API] Sending payload to API:", payload);

      fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(payload)
      })
      .then(response => {
        console.log("[API] Received response with status:", response.status);
        if (!response.ok) {
          throw new Error("Translation API error: " + response.statusText);
        }
        return response.json();
      })
      .then(data => {
        console.log("[API] Data from API:", data);
        if (data.error) {
          console.error("[API] API error:", data.error);
          return;
        }
        data.translations.forEach(translation => {
          const reqItem = toRequest.find(item => item.id === translation.id);
          if (reqItem) {
            const key = reqItem.id + "-" + this.config.targetLanguage;
            cache[key] = translation.translated;
            console.log(`[API] Caching translation for ${reqItem.id} with key ${key}:`, translation.translated);
          }
        });
        this._setCache(cache);
        const combined = cachedResults.concat(data.translations);
        console.log("[API] Combined translations:", combined);
        callback(combined);
      })
      .catch(error => {
        console.error("[API] Translation request failed:", error);
        this._hideLoadingIndicator();
      });
    },

    // --- Step 8: Apply translations to elements ---
    _applyTranslations: function(translations) {
      console.log("[Apply] Applying translations to elements.");
      translations.forEach(translation => {
        const el = document.getElementById(translation.id);
        if (!el) {
          console.warn("[Apply] No element found for key:", translation.id);
          return;
        }
        el.textContent = translation.translated;
        Array.from(el.classList).forEach(cls => {
          if (cls.indexOf("translated-") === 0) {
            el.classList.remove(cls);
            console.log(`[Apply] Removed old class ${cls} from element ${translation.id}`);
          }
        });
        el.classList.add(`translated-${this.config.targetLanguage}`);
        console.log(`[Apply] Updated element ${translation.id} with translation:`, translation.translated);
      });
      console.log("[Apply] Finished applying translations.");
    },

    // --- UI: Loading Indicator ---
    _showLoadingIndicator: function() {
      console.log("[UI] Showing loading indicator.");
      if (document.querySelector('.translation-loading-indicator')) return;
      const indicator = document.createElement('div');
      indicator.className = 'translation-loading-indicator';
      indicator.style.position = 'fixed';
      indicator.style.top = '10px';
      indicator.style.right = '10px';
      indicator.style.background = 'rgba(0,0,0,0.7)';
      indicator.style.color = 'white';
      indicator.style.padding = '8px 15px';
      indicator.style.borderRadius = '4px';
      indicator.style.fontFamily = 'system-ui, sans-serif';
      indicator.style.fontSize = '14px';
      indicator.style.zIndex = '10000';
      indicator.textContent = 'Translating...';
      document.body.appendChild(indicator);
    },
    _hideLoadingIndicator: function() {
      console.log("[UI] Hiding loading indicator.");
      const indicator = document.querySelector('.translation-loading-indicator');
      if (indicator) indicator.remove();
    },

    // --- Step 11: Mutation Observer to handle dynamic DOM changes ---
    _startTranslationPolling: function() {
      console.log("[Loop] Starting translation polling loop...");
      setInterval(() => {
        if (!this.config.targetLanguage || this.config.targetLanguage === this.config.sourceLanguage) {
          return;
        }
    
        const allElements = this.extractContent();
        const stored = localStorage.getItem(this._originalContentKey);
        const mapping = stored ? JSON.parse(stored) : {};
        const untranslated = allElements.filter(item => {
          const hasTranslatedClass = Array.from(item.element.classList).some(cls => cls === `translated-${this.config.targetLanguage}`);
          const isStored = mapping[item.id];
          return !hasTranslatedClass && !hasTranslatedClass && item.text.length > 0;
        });
    
        if (untranslated.length > 0) {
          console.log(`[Loop] Found ${untranslated.length} new untranslated elements.`);
          untranslated.forEach(item => {
            mapping[item.id] = {
              text: item.text,
              type: item.type,
              context: item.context
            };
          });
          localStorage.setItem(this._originalContentKey, JSON.stringify(mapping));
          this._sendTranslationRequest(untranslated, translations => {
            this._applyTranslations(translations);
          });
        }
      }, 1000); // every 1 second
    },

    // --- UI: Language Selector ---
    _addLanguageSelector: function() {
      console.log("[UI] Adding language selector UI.");
      const container = document.createElement('div');
      container.className = 'translation-language-selector no-translate';
      container.style.position = 'fixed';
      container.style.bottom = '20px';
      container.style.right = '20px';
      container.style.background = 'white';
      container.style.border = '1px solid #ddd';
      container.style.borderRadius = '4px';
      container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
      container.style.zIndex = '9999';
      container.style.overflow = 'hidden';

      const button = document.createElement('button');
      const initLang = this.config.targetLanguage || this.config.sourceLanguage;
      const initName = this._languageMapping[initLang] || initLang;
      button.innerHTML = `<span>🌐</span> <span>${initName}</span>`;
      button.style.background = 'none';
      button.style.border = 'none';
      button.style.padding = '10px 15px';
      button.style.cursor = 'pointer';
      button.style.display = 'flex';
      button.style.alignItems = 'center';
      button.style.gap = '8px';
      button.style.fontFamily = 'system-ui, sans-serif';
      button.style.fontSize = '14px';
      this._languageSelectorButton = button;

      const dropdown = document.createElement('div');
      dropdown.className = 'translation-language-dropdown';
      dropdown.style.display = 'none';
      dropdown.style.padding = '5px 0';
      dropdown.style.borderTop = '1px solid #ddd';

      const languages = [
        { code: this.config.sourceLanguage, name: this._languageMapping[this.config.sourceLanguage] },
        { code: 'hi', name: this._languageMapping['hi'] },
        { code: 'mr', name: this._languageMapping['mr'] },
        { code: 'ta', name: this._languageMapping['ta'] },
        { code: 'kn', name: this._languageMapping['kn'] },
        { code: 'pa', name: this._languageMapping['pa'] },
        { code: 'gu', name: this._languageMapping['gu'] }
      ];
      languages.forEach(lang => {
        const option = document.createElement('button');
        option.textContent = lang.name;
        option.dataset.language = lang.code;
        option.style.background = 'none';
        option.style.border = 'none';
        option.style.padding = '8px 15px';
        option.style.textAlign = 'left';
        option.style.cursor = 'pointer';
        option.style.width = '100%';
        option.style.fontSize = '14px';
        option.style.fontFamily = 'system-ui, sans-serif';
        option.addEventListener('click', () => {
          console.log(`[UI] Language option selected: ${lang.code}`);
          TranslationSDK.translatePage(lang.code);
          dropdown.style.display = 'none';
          Array.from(dropdown.children).forEach(child => {
            child.style.backgroundColor = 'transparent';
          });
          option.style.backgroundColor = '#f0f0f0';
        });
        dropdown.appendChild(option);
      });

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = (dropdown.style.display === 'none') ? 'block' : 'none';
        console.log("[UI] Toggled dropdown display to:", dropdown.style.display);
      });
      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
          dropdown.style.display = 'none';
          console.log("[UI] Click outside selector; hiding dropdown.");
        }
      });
      container.appendChild(button);
      container.appendChild(dropdown);
      document.body.appendChild(container);
      console.log("[UI] Language selector UI added.");
    },

    // --- Public init method ---
    init: function(options) {
      console.log("[Init] Initializing TranslationSDK with options:", options);
      this.config = { ...this.config, ...options };

      if (!this.config.siteId || !this.config.apiKey) {
        console.error("[Init] TranslationSDK: siteId and apiKey are required");
        return;
      }

      // Save original content after a short delay.
      setTimeout(() => {
        this._saveOriginalContent();
      }, 50);

      // Set up UI components, route change listener, and mutation observer.
      this._addLanguageSelector();
      this._setupRouteChangeListener();
      this._startTranslationPolling();

      const storedLanguage = localStorage.getItem('translation_language');
      console.log("[Init] Stored language:", storedLanguage);
      setTimeout(() => {
        if (this.config.autoTranslate) {
          console.log("[Init] Auto-translating to:", storedLanguage || this.config.targetLanguage);
          this.translatePage(storedLanguage || this.config.targetLanguage);
        } else if (storedLanguage) {
          console.log("[Init] Translating to stored language:", storedLanguage);
          this.translatePage(storedLanguage);
        }
      }, 100);

      console.log("[Init] TranslationSDK initialization complete.");
    }
  };

  window.TranslationSDK = TranslationSDK;
  console.log("[Global] TranslationSDK attached to window.");
})(window);
