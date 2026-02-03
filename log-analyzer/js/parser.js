/**
 * Log parser for Binance Futures Demo logs
 *
 * Log format:
 * [2026-01-27 00:12:51.414][INFO][module] [AUDIT][SPREAD_MET][ETH] Message | key=value, key=value
 */

const LogParser = {
  // Main log line pattern
  // Matches: [timestamp][level][module] rest of message
  LINE_PATTERN: /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\]\[(\w+)\]\[([^\]]+)\]\s*(.*)$/,

  // Audit tag pattern - matches [CATEGORY][SUBCATEGORY][ASSET] or variations
  // For LIFECYCLE: [LIFECYCLE][ASSET] message
  // For AUDIT: [AUDIT][SUBCATEGORY][ASSET] message
  AUDIT_PATTERN: /^\[(\w+)\](?:\[(\w+)\])?(?:\[(\w+)\])?\s*(.*)$/,

  // Known asset symbols (uppercase 2-5 chars)
  KNOWN_ASSETS: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC', 'LINK', 'LTC', 'UNI', 'ATOM', 'TRX', 'APT', 'ARB', 'OP', 'SUI', 'PEPE', 'SHIB', 'WLD', 'FIL', 'NEAR', 'INJ'],

  /**
   * Extract asset from symbol (e.g., ETHUSDT -> ETH, ETHUSDC -> ETH)
   * @param {string} symbol
   * @returns {string|null}
   */
  extractAssetFromSymbol(symbol) {
    if (!symbol) return null;
    // Remove USDT/USDC/BUSD suffix
    for (const suffix of ['USDT', 'USDC', 'BUSD']) {
      if (symbol.endsWith(suffix)) {
        const asset = symbol.slice(0, -suffix.length);
        if (this.KNOWN_ASSETS.includes(asset)) {
          return asset;
        }
      }
    }
    return null;
  },

  // Key=value pattern in message data
  KV_PATTERN: /(\w+)=([^,\s]+(?:\s+[^,=\s]+)*?)(?=,\s*\w+=|$)/g,

  /**
   * Parse a single log line
   * @param {string} line - Raw log line
   * @returns {LogEvent|null} - Parsed event or null if invalid
   */
  parseLine(line) {
    if (!line || line.trim() === '') return null;

    const lineMatch = line.match(this.LINE_PATTERN);
    if (!lineMatch) return null;

    const [, timestampStr, level, module, rest] = lineMatch;
    const timestamp = this.parseTimestamp(timestampStr);

    // Try to parse audit tags
    let category = null;
    let subcategory = null;
    let asset = null;
    let message = rest;
    let data = {};

    // Check for audit/lifecycle tags
    const auditMatch = rest.match(this.AUDIT_PATTERN);
    if (auditMatch) {
      const [, tag1, tag2, tag3, remaining] = auditMatch;

      // Helper to check if a tag looks like an asset
      const isAsset = (tag) => tag && this.KNOWN_ASSETS.includes(tag);

      // Determine what each tag represents based on the category
      if (tag1 === 'LIFECYCLE') {
        category = 'LIFECYCLE';
        // [LIFECYCLE][ASSET] or [LIFECYCLE][SUBCATEGORY][ASSET]
        if (isAsset(tag2)) {
          asset = tag2;
          subcategory = null;
        } else {
          subcategory = tag2 || null;
          asset = tag3 || null;
        }
        message = remaining;
      } else if (tag1 === 'AUDIT') {
        category = 'AUDIT';
        // [AUDIT][SUBCATEGORY][ASSET]
        subcategory = tag2 || null;
        asset = tag3 || null;
        message = remaining;
      } else {
        // Not an audit line, keep as-is
        message = rest;
      }
    }

    // Parse key=value pairs from message
    if (message.includes('|')) {
      const [msgPart, dataPart] = message.split('|', 2);
      message = msgPart.trim();
      data = this.parseKeyValues(dataPart);
    } else {
      // Try to extract key=value from message itself
      data = this.parseKeyValues(message);
    }

    // If no asset was found from tags, try to extract from symbol in data
    if (!asset && data.symbol) {
      asset = this.extractAssetFromSymbol(data.symbol);
    }

    return new LogEvent({
      timestamp,
      level,
      module,
      category,
      subcategory,
      asset,
      message,
      data
    });
  },

  /**
   * Parse timestamp string to Date object
   * @param {string} str - Timestamp string (YYYY-MM-DD HH:MM:SS.mmm)
   * @returns {Date}
   */
  parseTimestamp(str) {
    // Format: 2026-01-27 00:12:51.414
    const [datePart, timePart] = str.split(/\s+/);
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, secondMs] = timePart.split(':');
    const [second, ms] = secondMs.split('.').map(Number);

    return new Date(year, month - 1, day, Number(hour), Number(minute), second, ms);
  },

  /**
   * Parse key=value pairs from a string
   * @param {string} str - String containing key=value pairs
   * @returns {object}
   */
  parseKeyValues(str) {
    if (!str) return {};

    const data = {};
    const matches = str.matchAll(this.KV_PATTERN);

    for (const match of matches) {
      const key = match[1];
      let value = match[2].trim();

      // Try to convert numeric values
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        value = parseFloat(value);
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }

      data[key] = value;
    }

    return data;
  },

  /**
   * Parse multiple lines of log content
   * @param {string} content - Full log file content
   * @returns {LogEvent[]}
   */
  parseContent(content) {
    const lines = content.split('\n');
    const events = [];

    for (const line of lines) {
      const event = this.parseLine(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  },

  /**
   * Group events into strategy sessions
   * @param {LogEvent[]} events - All parsed events
   * @returns {StrategySession[]}
   */
  groupIntoSessions(events) {
    const sessions = [];
    const activeSessions = new Map(); // asset -> session

    for (const event of events) {
      // Check for session start: [LIFECYCLE][ETH] start_strategy called
      if (event.category === 'LIFECYCLE' &&
          event.asset &&
          event.message.includes('start_strategy called')) {
        const session = new StrategySession(event.asset, event.timestamp, event.data);
        session.addEvent(event);
        activeSessions.set(event.asset, session);
        sessions.push(session);
        continue;
      }

      // Check for session stop: [LIFECYCLE][ETH] StrategyExecutorTask::run completed
      if (event.category === 'LIFECYCLE' &&
          event.asset &&
          (event.message.includes('StrategyExecutorTask::run completed') ||
           event.message.includes('stop_strategy completed'))) {
        const session = activeSessions.get(event.asset);
        if (session) {
          session.endTime = event.timestamp;
          session.addEvent(event);
          activeSessions.delete(event.asset);
        }
        continue;
      }

      // Add event to matching active session
      if (event.asset && activeSessions.has(event.asset)) {
        activeSessions.get(event.asset).addEvent(event);
      } else if (event.asset) {
        // Event for an asset without active session - create orphan session
        // This handles cases where log starts mid-session
        const session = new StrategySession(event.asset, event.timestamp, {});
        session.addEvent(event);
        activeSessions.set(event.asset, session);
        sessions.push(session);
      } else if (!event.asset && activeSessions.size === 1) {
        // Event without asset tag, but only one active session - add to it
        const session = activeSessions.values().next().value;
        session.addEvent(event);
      } else if (!event.asset && activeSessions.size > 1 && event.category === 'AUDIT') {
        // Multiple active sessions - try to match by symbol in data
        // This shouldn't happen often since we extract asset from symbol above
        // But keep as fallback
      }
    }

    return sessions;
  },

  /**
   * Extract unique assets from events
   * @param {LogEvent[]} events
   * @returns {string[]}
   */
  extractAssets(events) {
    const assets = new Set();
    for (const event of events) {
      if (event.asset) {
        assets.add(event.asset);
      }
    }
    return Array.from(assets).sort();
  }
};

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.LogParser = LogParser;
}
