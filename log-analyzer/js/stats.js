/**
 * Statistics calculator for parsed log sessions
 */

const StatsCalculator = {
  /**
   * Calculate statistics for a single session
   * @param {StrategySession} session
   * @returns {SessionStats}
   */
  calculateSessionStats(session) {
    const stats = new SessionStats();
    stats.runtime = session.duration;

    // Track orders by ID for correlation
    const orderMap = new Map(); // order_id -> order info
    const pairMap = new Map();  // pair_id -> { usdt, usdc }

    for (const event of session.events) {
      this.processEvent(event, stats, orderMap, pairMap);
    }

    // Calculate order pair statistics from pair map
    for (const [pairId, pair] of pairMap) {
      stats.orderPairs.attempted++;
      if (pair.usdtFilled && pair.usdcFilled) {
        stats.orderPairs.succeeded++;
      }
    }

    return stats;
  },

  /**
   * Process a single event and update stats
   */
  processEvent(event, stats, orderMap, pairMap) {
    if (!event.category) return;

    switch (event.subcategory) {
      case 'SPREAD_MET':
        stats.spreadTriggers++;
        break;

      case 'ORDER_SUBMIT':
        stats.orders.total++;
        if (event.data.order_id) {
          orderMap.set(event.data.order_id, {
            symbol: event.data.symbol,
            side: event.data.side,
            qty: event.data.qty,
            price: event.data.price,
            status: 'pending',
            timestamp: event.timestamp,
            pairId: event.data.pair_id
          });
        }
        break;

      case 'ORDER_RESPONSE':
        // Track latency regardless of outcome
        if (event.data.latency_ms) {
          stats.orders.latencies.push(event.data.latency_ms);
        }

        // Check message for accepted/rejected status
        // "[AUDIT][ORDER_RESPONSE] Order accepted | ..." or "Order rejected | ..."
        const isAccepted = event.message && event.message.includes('Order accepted');
        const isRejected = event.message && event.message.includes('Order rejected');

        if (event.data.order_id) {
          const order = orderMap.get(event.data.order_id);
          if (order) {
            if (isAccepted || event.data.status === 'accepted' || event.data.status === 'NEW') {
              order.status = 'accepted';
              stats.orders.accepted++;
            } else if (isRejected) {
              order.status = 'rejected';
              stats.orders.rejected++;

              // Check for GTX rejection in error message
              if (event.data.error && event.data.error.includes('GTX')) {
                stats.errors.gtxRejections++;
              } else if (event.message && event.message.includes('GTX')) {
                stats.errors.gtxRejections++;
              }
            }
          } else if (isAccepted) {
            // Order response without prior submit (order may have been created differently)
            stats.orders.accepted++;
          } else if (isRejected) {
            stats.orders.rejected++;
            if ((event.data.error && event.data.error.includes('GTX')) ||
                (event.message && event.message.includes('GTX'))) {
              stats.errors.gtxRejections++;
            }
          }
        }
        break;

      case 'ORDER_FILL':
        stats.fills.total++;

        // Check message for partial fill
        // "[AUDIT][ORDER_FILL][ETH] Partial fill | order_id=..., symbol=..., filled=..., remaining=..., last_price=..."
        // vs "[AUDIT][ORDER_FILL][ETH] USDT order filled | order_id=..., filled=..., total=..., price=..."
        const isPartial = event.message && event.message.includes('Partial fill');

        if (isPartial || event.data.fill_type === 'partial') {
          stats.fills.partial++;
        } else {
          stats.fills.full++;
        }

        // Track filled quantity - use last_filled from log
        const filledQty = parseFloat(event.data.last_filled) || parseFloat(event.data.filled) || parseFloat(event.data.qty) || 0;
        stats.fills.totalQty += filledQty;

        // Track by symbol type (USDT vs USDC)
        // For partial fills: symbol is in data (e.g., symbol=ETHUSDT)
        // For full fills: symbol is in message (e.g., "USDT order filled" or "USDC order filled")
        let symbol = event.data.symbol || '';
        if (!symbol && event.message) {
          if (event.message.includes('USDT order filled')) {
            symbol = 'USDT';
          } else if (event.message.includes('USDC order filled')) {
            symbol = 'USDC';
          }
        }

        if (symbol.includes('USDT')) {
          stats.fills.usdtQty += filledQty;
        } else if (symbol.includes('USDC')) {
          stats.fills.usdcQty += filledQty;
        }

        // Track price
        if (event.data.price) {
          stats.fills.prices.push(parseFloat(event.data.price));
        } else if (event.data.last_price) {
          stats.fills.prices.push(parseFloat(event.data.last_price));
        } else if (event.data.fill_price) {
          stats.fills.prices.push(parseFloat(event.data.fill_price));
        }

        // Update order status
        if (event.data.order_id) {
          const order = orderMap.get(event.data.order_id);
          if (order) {
            order.status = isPartial ? 'partial' : 'filled';

            // Update pair tracking
            if (order.pairId) {
              if (!pairMap.has(order.pairId)) {
                pairMap.set(order.pairId, { usdtFilled: false, usdcFilled: false });
              }
              const pair = pairMap.get(order.pairId);
              if (order.symbol && order.symbol.includes('USDT')) {
                pair.usdtFilled = true;
              } else if (order.symbol && order.symbol.includes('USDC')) {
                pair.usdcFilled = true;
              }
            }
          }
        }
        break;

      case 'PARALLEL_ORDER':
        // Track pair creation
        if (event.data.pair_id) {
          if (!pairMap.has(event.data.pair_id)) {
            pairMap.set(event.data.pair_id, { usdtFilled: false, usdcFilled: false });
          }
        }
        break;

      case 'PAIR_LINK':
        // Track order pair linking
        if (event.data.pair_id) {
          if (!pairMap.has(event.data.pair_id)) {
            pairMap.set(event.data.pair_id, { usdtFilled: false, usdcFilled: false });
          }
        }
        break;

      case 'FAST_CHASE':
        this.processFastChaseEvent(event, stats);
        break;

      case 'BALANCE':
        // Balance events don't contribute to stats directly
        break;

      case 'ORDER_STATE':
        // "[AUDIT][ORDER_STATE][ETH] Order expired (GTX rejected)"
        if (event.message && event.message.includes('GTX rejected')) {
          stats.errors.gtxRejections++;
        } else if (event.message && event.message.includes('Order rejected')) {
          // Other rejection types
        }
        break;

      case 'ORDER_CANCEL':
        // Order cancellation events - not counted as errors
        break;

      case 'ORDER_TIMEOUT':
        stats.errors.timeouts++;
        break;

      default:
        // Check for error conditions
        if (event.level === 'ERROR') {
          if (event.message && event.message.includes('timeout')) {
            stats.errors.timeouts++;
          } else if (event.message && event.message.includes('API')) {
            stats.errors.apiErrors++;
          } else {
            stats.errors.other++;
          }
        }
        break;
    }
  },

  /**
   * Process fast chase specific events
   */
  processFastChaseEvent(event, stats) {
    const msg = event.message || '';

    // "[AUDIT][FAST_CHASE][ETH] Entering fast chase mode"
    if (msg.includes('Entering fast chase mode')) {
      stats.fastChase.events++;
    }
    // "[AUDIT][FAST_CHASE][ETH] Fast chase completed successfully | retry_count=..."
    else if (msg.includes('Fast chase completed successfully')) {
      stats.fastChase.successes++;
      if (event.data.retry_count !== undefined) {
        stats.fastChase.retries.push(event.data.retry_count);
      }
    }
    // "[AUDIT][FAST_CHASE][ETH] Fast chase fallback triggered | reason=..."
    else if (msg.includes('fallback') || msg.includes('Fallback') || msg.includes('FALLBACK')) {
      const reason = event.data.reason || 'unknown';
      stats.fastChase.fallbackReasons[reason] = (stats.fastChase.fallbackReasons[reason] || 0) + 1;
    }
  },

  /**
   * Calculate aggregate statistics across multiple sessions
   * @param {StrategySession[]} sessions
   * @returns {SessionStats}
   */
  calculateAggregateStats(sessions) {
    const aggregate = new SessionStats();

    for (const session of sessions) {
      const sessionStats = this.calculateSessionStats(session);

      aggregate.runtime += sessionStats.runtime;
      aggregate.spreadTriggers += sessionStats.spreadTriggers;
      aggregate.orderPairs.attempted += sessionStats.orderPairs.attempted;
      aggregate.orderPairs.succeeded += sessionStats.orderPairs.succeeded;

      aggregate.orders.total += sessionStats.orders.total;
      aggregate.orders.accepted += sessionStats.orders.accepted;
      aggregate.orders.rejected += sessionStats.orders.rejected;
      aggregate.orders.latencies.push(...sessionStats.orders.latencies);

      aggregate.fills.total += sessionStats.fills.total;
      aggregate.fills.partial += sessionStats.fills.partial;
      aggregate.fills.full += sessionStats.fills.full;
      aggregate.fills.totalQty += sessionStats.fills.totalQty;
      aggregate.fills.usdtQty += sessionStats.fills.usdtQty;
      aggregate.fills.usdcQty += sessionStats.fills.usdcQty;
      aggregate.fills.prices.push(...sessionStats.fills.prices);

      aggregate.fastChase.events += sessionStats.fastChase.events;
      aggregate.fastChase.successes += sessionStats.fastChase.successes;
      aggregate.fastChase.retries.push(...sessionStats.fastChase.retries);
      for (const [reason, count] of Object.entries(sessionStats.fastChase.fallbackReasons)) {
        aggregate.fastChase.fallbackReasons[reason] =
          (aggregate.fastChase.fallbackReasons[reason] || 0) + count;
      }

      aggregate.errors.gtxRejections += sessionStats.errors.gtxRejections;
      aggregate.errors.apiErrors += sessionStats.errors.apiErrors;
      aggregate.errors.timeouts += sessionStats.errors.timeouts;
      aggregate.errors.other += sessionStats.errors.other;
    }

    return aggregate;
  },

  /**
   * Extract order details for table display
   * @param {StrategySession[]} sessions
   * @returns {OrderDetail[]}
   */
  extractOrderDetails(sessions) {
    const orders = [];
    const orderMap = new Map();
    const pendingSubmits = [];  // ORDER_SUBMIT events waiting for ORDER_RESPONSE

    for (const session of sessions) {
      for (const event of session.events) {
        if (event.subcategory === 'ORDER_SUBMIT') {
          // Store submit event to match with response later
          pendingSubmits.push({
            timestamp: event.timestamp,
            symbol: event.data.symbol,
            side: event.data.side,
            orderType: event.data.type || 'LIMIT',
            quantity: event.data.qty,
            price: event.data.price
          });
        } else if (event.subcategory === 'ORDER_RESPONSE') {
          const orderId = event.data.order_id;
          if (!orderId) continue;

          // Find matching submit event by symbol
          const symbol = event.data.symbol;
          const submitIdx = pendingSubmits.findIndex(s => s.symbol === symbol);
          const submitInfo = submitIdx >= 0 ? pendingSubmits.splice(submitIdx, 1)[0] : null;

          const isAccepted = event.message && event.message.includes('Order accepted');
          const isRejected = event.message && event.message.includes('Order rejected');

          const detail = new OrderDetail({
            timestamp: submitInfo ? submitInfo.timestamp : event.timestamp,
            symbol: symbol,
            side: submitInfo ? submitInfo.side : null,
            orderType: submitInfo ? submitInfo.orderType : 'LIMIT',
            quantity: submitInfo ? submitInfo.quantity : null,
            price: submitInfo ? submitInfo.price : null,
            status: isAccepted ? 'accepted' : (isRejected ? 'rejected' : 'unknown'),
            orderId: orderId,
            latency: event.data.latency_ms || null,
            pairId: null
          });

          orders.push(detail);
          orderMap.set(orderId, detail);
        } else if (event.subcategory === 'ORDER_FILL') {
          const orderId = event.data.order_id;
          if (orderId && orderMap.has(orderId)) {
            const detail = orderMap.get(orderId);
            const isPartial = event.message && event.message.includes('Partial fill');

            detail.fillTime = event.timestamp;
            // Use last_filled for filled amount
            if (event.data.last_filled !== undefined) {
              detail.filledQty = parseFloat(event.data.last_filled) || 0;
            }
            if (event.data.accumulated !== undefined) {
              detail.accumulated = parseFloat(event.data.accumulated) || 0;
            }
            detail.status = isPartial ? 'partial' : 'filled';
          }
        }
      }
    }

    // Sort by timestamp
    orders.sort((a, b) => a.submitTime - b.submitTime);

    return orders;
  },

  /**
   * Extract order details grouped by session
   * Shows each fill event as a separate row
   * @param {StrategySession[]} sessions
   * @returns {Array<{session: object, orders: OrderDetail[]}>}
   */
  extractOrdersBySession(sessions) {
    const result = [];

    for (const session of sessions) {
      const rows = [];                   // Each row is either an order or a fill
      const orderMap = new Map();        // order_id -> base order info
      const pendingSubmits = [];         // ORDER_SUBMIT events waiting for ORDER_RESPONSE

      for (const event of session.events) {
        if (event.subcategory === 'ORDER_SUBMIT') {
          // Store submit event to match with response later
          pendingSubmits.push({
            timestamp: event.timestamp,
            symbol: event.data.symbol,
            side: event.data.side,
            orderType: event.data.type || 'LIMIT',
            quantity: event.data.qty,
            price: event.data.price
          });
        } else if (event.subcategory === 'ORDER_RESPONSE') {
          const orderId = event.data.order_id;
          if (!orderId) continue;

          // Find matching submit event by symbol
          const symbol = event.data.symbol;
          const submitIdx = pendingSubmits.findIndex(s => s.symbol === symbol);
          const submitInfo = submitIdx >= 0 ? pendingSubmits.splice(submitIdx, 1)[0] : null;

          const isAccepted = event.message && event.message.includes('Order accepted');
          const isRejected = event.message && event.message.includes('Order rejected');

          // Store base order info for later fill events
          orderMap.set(orderId, {
            submitTime: submitInfo ? submitInfo.timestamp : event.timestamp,
            symbol: symbol,
            side: submitInfo ? submitInfo.side : null,
            orderType: submitInfo ? submitInfo.orderType : 'LIMIT',
            quantity: submitInfo ? submitInfo.quantity : null,
            price: submitInfo ? submitInfo.price : null,
            latency: event.data.latency_ms || null,
            status: isAccepted ? 'accepted' : (isRejected ? 'rejected' : 'unknown')
          });

          // Add order row (without fill info yet)
          const detail = new OrderDetail({
            timestamp: submitInfo ? submitInfo.timestamp : event.timestamp,
            symbol: symbol,
            side: submitInfo ? submitInfo.side : null,
            orderType: submitInfo ? submitInfo.orderType : 'LIMIT',
            quantity: submitInfo ? submitInfo.quantity : null,
            price: submitInfo ? submitInfo.price : null,
            status: isAccepted ? 'accepted' : (isRejected ? 'rejected' : 'unknown'),
            orderId: orderId,
            latency: event.data.latency_ms || null,
            pairId: null
          });
          rows.push(detail);
        } else if (event.subcategory === 'ORDER_FILL') {
          const orderId = event.data.order_id;
          const baseOrder = orderMap.get(orderId);
          const isPartial = event.message && event.message.includes('Partial fill');

          // Create a fill row
          const fillRow = new OrderDetail({
            timestamp: baseOrder ? baseOrder.submitTime : event.timestamp,
            symbol: event.data.symbol || (baseOrder ? baseOrder.symbol : null),
            side: baseOrder ? baseOrder.side : null,
            orderType: baseOrder ? baseOrder.orderType : 'LIMIT',
            quantity: baseOrder ? baseOrder.quantity : null,
            price: event.data.last_price || event.data.price || (baseOrder ? baseOrder.price : null),
            status: isPartial ? 'partial' : 'filled',
            orderId: orderId,
            latency: baseOrder ? baseOrder.latency : null,
            pairId: null
          });
          fillRow.fillTime = event.timestamp;
          fillRow.filledQty = parseFloat(event.data.last_filled) || 0;
          // cumulative_filled for partial fills, total_filled for full fills
          fillRow.cumulativeFilled = parseFloat(event.data.cumulative_filled) || parseFloat(event.data.total_filled) || 0;
          fillRow.accumulated = parseFloat(event.data.accumulated) || 0;

          rows.push(fillRow);

          // Remove the "accepted" row for this order since we now have fill info
          const acceptedIdx = rows.findIndex(r => r.orderId === orderId && r.status === 'accepted');
          if (acceptedIdx >= 0) {
            rows.splice(acceptedIdx, 1);
          }
        } else if (event.subcategory === 'ORDER_STATE') {
          const orderId = event.data.order_id;
          if (orderId && orderMap.has(orderId)) {
            const baseOrder = orderMap.get(orderId);
            if (event.message && event.message.includes('GTX rejected')) {
              baseOrder.status = 'rejected';
              // Update status of the order row
              const orderRow = rows.find(r => r.orderId === orderId && r.status === 'accepted');
              if (orderRow) orderRow.status = 'rejected';
            } else if (event.message && event.message.includes('canceled')) {
              baseOrder.status = 'canceled';
              const orderRow = rows.find(r => r.orderId === orderId && r.status === 'accepted');
              if (orderRow) orderRow.status = 'canceled';
            }
          }
        } else if (event.subcategory === 'PAIR_LINK') {
          // Link pair_id to orders
          const pairId = event.data.pair_id;
          const usdtOrderId = event.data.usdt_order;
          const usdcOrderId = event.data.usdc_order;
          rows.forEach(r => {
            if (r.orderId === usdtOrderId || r.orderId === usdcOrderId) {
              r.pairId = pairId;
            }
          });
        }
      }

      // Sort rows by fill time (if exists) or submit time
      rows.sort((a, b) => {
        const timeA = a.fillTime || a.submitTime;
        const timeB = b.fillTime || b.submitTime;
        return timeA - timeB;
      });

      // Calculate session stats for summary
      const sessionStats = this.calculateSessionStats(session);

      result.push({
        session: {
          asset: session.asset,
          startTime: session.startTime,
          endTime: session.endTime,
          duration: session.durationString,
          config: session.config
        },
        stats: {
          spreadTriggers: sessionStats.spreadTriggers,
          orderPairs: {
            attempted: sessionStats.orderPairs.attempted,
            succeeded: sessionStats.orderPairs.succeeded,
            successRate: sessionStats.orderPairs.successRate
          },
          orders: {
            total: sessionStats.orders.total,
            accepted: sessionStats.orders.accepted,
            rejected: sessionStats.orders.rejected
          },
          fills: {
            total: sessionStats.fills.total,
            totalQty: sessionStats.fills.totalQty,
            usdtQty: sessionStats.fills.usdtQty,
            usdcQty: sessionStats.fills.usdcQty
          }
        },
        orders: rows
      });
    }

    return result;
  },

  /**
   * Format runtime duration
   * @param {number} ms - Duration in milliseconds
   * @returns {string}
   */
  formatDuration(ms) {
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
  },

  /**
   * Format quantity with appropriate precision, removing trailing zeros
   * @param {number} qty
   * @returns {string}
   */
  formatQuantity(qty) {
    if (qty === 0) return '0';
    if (qty < 0.001) return parseFloat(qty.toFixed(6)).toString();
    if (qty < 1) return parseFloat(qty.toFixed(4)).toString();
    return parseFloat(qty.toFixed(3)).toString();
  }
};

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.StatsCalculator = StatsCalculator;
}
