(function () {
  'use strict';

  var routes = {
    getInitialState: ['GET', '/api/state'],
    disconnectTikTok: ['POST', '/api/oauth/disconnect'],
    verifyAdminPassword: ['POST', '/api/admin/verify'],
    getGmvMaxStores: ['POST', '/api/stores'],
    getTikTokConnectUrl: ['GET', '/api/oauth/connect'],
    loadReport: ['POST', '/api/report'],
    loadRevenueAnalysis: ['POST', '/api/revenue-analysis'],
    loadContentKocAnalysis: ['POST', '/api/content-koc-analysis'],
    loadOperationsAnalysis: ['POST', '/api/operations-analysis'],
    loadFinanceAnalysis: ['POST', '/api/finance-analysis'],
    saveFinanceSkuCost: ['POST', '/api/finance-sku-cost'],
    loadProductVideos: ['POST', '/api/product-videos'],
    loadCreativeSummaries: ['POST', '/api/creative-summaries'],
    loadYesterdayComparison: ['POST', '/api/comparison'],
    loadVideoStats: ['POST', '/api/video-stats'],
    loadVideoMetadata: ['POST', '/api/video-metadata']
  };

  function invoke(name, args, success, failure) {
    var route = routes[name];
    if (!route) {
      failure(new Error('API method không được hỗ trợ: ' + name));
      return;
    }
    var method = route[0];
    var options = { method: method, headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(args.length <= 1 ? args[0] : args);
    }
    fetch(route[1], options).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: 'Phản hồi API không hợp lệ.' };
      }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || ('HTTP ' + response.status));
        }
        return payload.data;
      });
    }).then(success).catch(failure);
  }

  function runner(success, failure) {
    var chain = {
      withSuccessHandler: function (handler) { return runner(handler, failure); },
      withFailureHandler: function (handler) { return runner(success, handler); }
    };
    return new Proxy(chain, {
      get: function (target, property) {
        if (property in target) return target[property];
        return function () {
          invoke(
            String(property), Array.prototype.slice.call(arguments),
            success || function () {},
            failure || function (error) { console.error(error); }
          );
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', {
    configurable: false,
    get: function () { return runner(); }
  });
}());
