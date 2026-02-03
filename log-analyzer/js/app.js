/**
 * Vue 3 Application for Binance Log Analyzer
 */

const { createApp, ref, computed, onMounted } = Vue;

const app = createApp({
  setup() {
    // State
    const fileInfo = ref(null);
    const rawContent = ref('');
    const events = ref([]);
    const sessions = ref([]);
    const selectedAsset = ref('all');
    const isLoading = ref(false);
    const errorMessage = ref('');
    const isDragOver = ref(false);
    const allOrdersExpanded = ref(false);

    // Computed
    const assets = computed(() => {
      return LogParser.extractAssets(events.value);
    });

    const filteredSessions = computed(() => {
      if (selectedAsset.value === 'all') {
        return sessions.value;
      }
      return sessions.value.filter(s => s.asset === selectedAsset.value);
    });

    const stats = computed(() => {
      if (filteredSessions.value.length === 0) {
        return null;
      }
      return StatsCalculator.calculateAggregateStats(filteredSessions.value);
    });

    const orderDetails = computed(() => {
      return StatsCalculator.extractOrderDetails(filteredSessions.value);
    });

    const sessionOrderHistory = computed(() => {
      return StatsCalculator.extractOrdersBySession(filteredSessions.value);
    });

    const totalLines = computed(() => {
      return rawContent.value.split('\n').filter(l => l.trim()).length;
    });

    // Methods
    const handleFileSelect = (event) => {
      const file = event.target.files[0];
      if (file) {
        loadFile(file);
      }
    };

    const handleDrop = (event) => {
      event.preventDefault();
      isDragOver.value = false;

      const file = event.dataTransfer.files[0];
      if (file) {
        loadFile(file);
      }
    };

    const handleDragOver = (event) => {
      event.preventDefault();
      isDragOver.value = true;
    };

    const handleDragLeave = () => {
      isDragOver.value = false;
    };

    const loadFile = async (file) => {
      isLoading.value = true;
      errorMessage.value = '';

      try {
        const content = await file.text();
        rawContent.value = content;

        fileInfo.value = {
          name: file.name,
          size: formatFileSize(file.size),
          lastModified: new Date(file.lastModified).toLocaleDateString()
        };

        parseContent(content);
      } catch (error) {
        errorMessage.value = `Failed to load file: ${error.message}`;
        console.error('File load error:', error);
      } finally {
        isLoading.value = false;
      }
    };

    const parseContent = (content) => {
      events.value = LogParser.parseContent(content);
      sessions.value = LogParser.groupIntoSessions(events.value);
      selectedAsset.value = 'all';
    };

    const formatFileSize = (bytes) => {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const formatDuration = (ms) => {
      return StatsCalculator.formatDuration(ms);
    };

    const formatQuantity = (qty) => {
      return StatsCalculator.formatQuantity(qty);
    };

    const formatTime = (date) => {
      if (!date) return '-';
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const exportJson = () => {
      if (!stats.value) return;

      const exportData = {
        fileInfo: fileInfo.value,
        filter: selectedAsset.value,
        sessions: filteredSessions.value.map(s => ({
          asset: s.asset,
          startTime: s.startTime,
          endTime: s.endTime,
          duration: s.durationString,
          config: s.config,
          eventCount: s.events.length
        })),
        statistics: {
          runtime: formatDuration(stats.value.runtime),
          spreadTriggers: stats.value.spreadTriggers,
          orderPairs: {
            attempted: stats.value.orderPairs.attempted,
            succeeded: stats.value.orderPairs.succeeded,
            successRate: stats.value.orderPairs.successRate + '%'
          },
          orders: {
            total: stats.value.orders.total,
            accepted: stats.value.orders.accepted,
            rejected: stats.value.orders.rejected,
            acceptRate: stats.value.orders.acceptRate + '%',
            avgLatency: stats.value.orders.avgLatency + 'ms'
          },
          fills: {
            total: stats.value.fills.total,
            partial: stats.value.fills.partial,
            full: stats.value.fills.full,
            totalQty: formatQuantity(stats.value.fills.totalQty),
            avgPrice: stats.value.fills.avgPrice
          },
          fastChase: {
            events: stats.value.fastChase.events,
            successes: stats.value.fastChase.successes,
            successRate: stats.value.fastChase.successRate + '%',
            avgRetries: stats.value.fastChase.avgRetries,
            fallbackReasons: stats.value.fastChase.fallbackReasons
          },
          errors: stats.value.errors
        },
        orders: orderDetails.value.map(o => ({
          time: o.timeString,
          symbol: o.symbol,
          side: o.side,
          type: o.orderType,
          quantity: o.quantity,
          price: o.price,
          status: o.statusText,
          latency: o.latency ? o.latency + 'ms' : null,
          orderId: o.orderId,
          pairId: o.pairId
        })),
        exportedAt: new Date().toISOString()
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `log-analysis-${fileInfo.value?.name || 'export'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };

    return {
      // State
      fileInfo,
      events,
      sessions,
      selectedAsset,
      isLoading,
      errorMessage,
      isDragOver,
      allOrdersExpanded,

      // Computed
      assets,
      filteredSessions,
      stats,
      orderDetails,
      sessionOrderHistory,
      totalLines,

      // Methods
      handleFileSelect,
      handleDrop,
      handleDragOver,
      handleDragLeave,
      formatDuration,
      formatQuantity,
      formatTime,
      exportJson
    };
  }
});

// Mount app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  app.mount('#app');
});
