/* 灯下 sw.js（build_app.py 产）：版本化预缓存=改版即整换；词典全本独立缓存名
   （内容不变不重下 34MB）；跨域（api.github.com 等）与非 GET 一律直通不拦。 */
var V="dx-55ab55d0", DICT="dx-dict-12743b91";
var PRE=["./", "./math.html", "./universe.html", "./game_shell.html", "./data_408.enc", "./data_exam.enc", "./game.html", "./sync_core.js", "./index.html", "./icon-512.png", "./icon-192.png", "./icon-180.png", "./manifest.webmanifest"];
self.addEventListener("install",function(e){
  e.waitUntil(caches.open(V).then(function(c){return c.addAll(PRE);}).then(function(){return self.skipWaiting();}));
});
self.addEventListener("activate",function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){return k!==V&&k!==DICT;}).map(function(k){return caches.delete(k);}));
  }).then(function(){return self.clients.claim();}));
});
self.addEventListener("fetch",function(e){
  var u; try{u=new URL(e.request.url);}catch(err){return;}
  if(u.origin!==location.origin)return;
  if(e.request.method!=="GET")return;
  var isDict=/dict_data\.js$/.test(u.pathname);
  var cn=isDict?DICT:V;
  e.respondWith(caches.open(cn).then(function(c){
    return c.match(e.request,{ignoreSearch:true}).then(function(hit){
      if(hit)return hit;
      return fetch(e.request).then(function(r){
        if(r&&r.ok){var cl=r.clone();c.put(e.request,cl);}
        return r;
      });
    });
  }).catch(function(){
    return caches.open(V).then(function(c){return c.match("./index.html");});
  }));
});
