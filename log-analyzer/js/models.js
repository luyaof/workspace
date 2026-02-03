/**
 * Data models for log parsing
 */

/**
 * Represents a single parsed log event
 */
class LogEvent {
  constructor({
    timestamp,
    level,
    module,
    category,
    subcategory,
    asset,
    message,
    data
  }) {
    this.timestamp = timestamp;
    this.level = level;           // INFO, WARN, ERROR
    this.module = module;
    this.category = category;     // LIFECYCLE, AUDIT
    this.subcategory = subcategory; // SPREAD_MET, ORDER_FILL, etc.
    this.asset = asset;           // ETH, BTC, SOL
    this.message = message;
    this.data = data || {};       // key=value parsed results
  }

  /**
   * Get a formatted time string (HH:MM:SS.mmm)
   */
  get timeString() {
    if (!this.timestamp) return '';
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const d = this.timestamp;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
}

/**
 * Represents a trading strategy session (from start to stop)
 */
class StrategySession {
  constructor(asset, startTime, config = {}) {
    this.asset = asset;
    this.startTime = startTime;
    this.endTime = null;
    this.config = {
      qty: config.qty || null,
      direction: config.direction || null,
      spreadThreshold: config.spread_threshold || null
    };
    this.events = [];
  }

  addEvent(event) {
    this.events.push(event);
  }

  /**
   * Get session duration in milliseconds
   */
  get duration() {
    if (!this.startTime) return 0;
    const end = this.endTime || (this.events.length > 0
      ? this.events[this.events.length - 1].timestamp
      : this.startTime);
    return end - this.startTime;
  }

  /**
   * Get formatted duration string
   */
  get durationString() {
    const ms = this.duration;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h${minutes % 60}m${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Represents statistics for a session
 */
class SessionStats {
  constructor() {
    this.runtime = 0;
    this.spreadTriggers = 0;
    this.orderPairs = {
      attempted: 0,
      succeeded: 0,
      get successRate() {
        return this.attempted > 0
          ? ((this.succeeded / this.attempted) * 100).toFixed(1)
          : '0.0';
      }
    };
    this.orders = {
      total: 0,
      accepted: 0,
      rejected: 0,
      latencies: [],
      get avgLatency() {
        if (this.latencies.length === 0) return 0;
        const sum = this.latencies.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.latencies.length);
      },
      get acceptRate() {
        return this.total > 0
          ? ((this.accepted / this.total) * 100).toFixed(1)
          : '0.0';
      }
    };
    this.fills = {
      total: 0,
      partial: 0,
      full: 0,
      totalQty: 0,
      usdtQty: 0,
      usdcQty: 0,
      prices: [],
      get avgPrice() {
        if (this.prices.length === 0) return 0;
        const sum = this.prices.reduce((a, b) => a + b, 0);
        return (sum / this.prices.length).toFixed(2);
      }
    };
    this.fastChase = {
      events: 0,
      successes: 0,
      retries: [],
      fallbackReasons: {},
      get successRate() {
        return this.events > 0
          ? ((this.successes / this.events) * 100).toFixed(1)
          : '0.0';
      },
      get avgRetries() {
        if (this.retries.length === 0) return 0;
        const sum = this.retries.reduce((a, b) => a + b, 0);
        return (sum / this.retries.length).toFixed(1);
      }
    };
    this.errors = {
      gtxRejections: 0,
      apiErrors: 0,
      timeouts: 0,
      other: 0
    };
  }
}

/**
 * Order detail for display in table
 */
class OrderDetail {
  constructor({
    timestamp,
    symbol,
    side,
    orderType,
    quantity,
    price,
    status,
    orderId,
    latency,
    pairId
  }) {
    this.submitTime = timestamp;   // When order was submitted
    this.fillTime = null;          // When order was last filled
    this.symbol = symbol;
    this.side = side;
    this.orderType = orderType;
    this.quantity = quantity;      // Submitted quantity
    this.filledQty = 0;            // Amount filled in this fill event (last_filled)
    this.cumulativeFilled = 0;     // Cumulative filled for this order (cumulative_filled or total_filled)
    this.price = price;
    this.status = status;          // accepted, rejected, filled, partial, canceled
    this.orderId = orderId;
    this.latency = latency;
    this.pairId = pairId;
    this.accumulated = null;       // Accumulated from fill event (across all orders in session)
  }

  get submitTimeString() {
    if (!this.submitTime) return '';
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const d = this.submitTime;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  get fillTimeString() {
    if (!this.fillTime) return '-';
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const d = this.fillTime;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // For backward compatibility
  get timeString() {
    return this.submitTimeString;
  }

  get statusIcon() {
    switch (this.status) {
      case 'filled': return '✅';
      case 'partial': return '⏳';
      case 'accepted': return '📝';
      case 'rejected': return '❌';
      case 'canceled': return '🚫';
      default: return '❓';
    }
  }

  get statusText() {
    switch (this.status) {
      case 'filled': return 'Filled';
      case 'partial': return 'Partial';
      case 'accepted': return 'Accepted';
      case 'rejected': return 'Rejected';
      case 'canceled': return 'Canceled';
      default: return 'Unknown';
    }
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.LogEvent = LogEvent;
  window.StrategySession = StrategySession;
  window.SessionStats = SessionStats;
  window.OrderDetail = OrderDetail;
}
