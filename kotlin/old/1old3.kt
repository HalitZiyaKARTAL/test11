package a.htmlapprealizer

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityGestureEvent
import android.accessibilityservice.GestureDescription
import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.Color
import android.media.projection.MediaProjection
import android.net.Uri
import android.os.*
import android.service.notification.*
import android.view.*
import android.view.accessibility.AccessibilityEvent
import android.webkit.*
import android.widget.*
import org.json.*
import java.io.File
import java.lang.reflect.*
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.jvm.JvmField

/*
K.q(epoch,target,member,json,callback)
target: class name, P handle, or @port. PP and @@ escape literal strings.
member: constructor, method, @proxy, +retain, -release, or ~epoch-cleanup method.
*/
object Core {
  @Volatile var events = false
  @JvmField val hosts = ConcurrentHashMap.newKeySet<String>()
  @JvmField val sessionHosts = ConcurrentHashMap.newKeySet<String>()
  @JvmField val ports = ConcurrentHashMap<String, Any>()
  @JvmField val droppedEvents = AtomicInteger()
  @JvmField @Volatile var eventQueueLimit = 1024
  @JvmField @Volatile var urgentQueueLimit = 256
  @JvmField @Volatile var deliveryTimeout = 30_000L

  private data class Held(val value: Any, val epoch: String)
  private val heap = ConcurrentHashMap<Long, Held>()
  private val waits = ConcurrentHashMap<String, String>()
  private val next = AtomicLong()
  private val main = Handler(Looper.getMainLooper())
  private val localSchemes = setOf("about", "blob", "content", "data", "file")
  private val localHosts = setOf("html.realizer.local")
  private object Missing
  private lateinit var app: Context
  private lateinit var wrapper: MutableContextWrapper
  @Volatile private var key = ""
  @Volatile private var ready = false
  @Volatile private var documentUrl = ""
  private val ownerVersion = AtomicInteger()
  @Volatile var web: WebView? = null
    private set
  val trusted get() = key.isNotEmpty()

  private data class Delivery(
    val type: String, val id: Int, val token: String, val epoch: String,
    val priority: Boolean
  )
  private val urgent = ArrayDeque<Delivery>()
  private val normal = ArrayDeque<Delivery>()
  private var active: Delivery? = null
  private var activeSerial = 0L
  private var timeout: Runnable? = null
  private val pendingUrgent = AtomicInteger()
  private val pendingNormal = AtomicInteger()

  @Synchronized fun ensure(context: Context): WebView {
    web?.takeUnless { it.isDestroyed }?.let { return it }
    app = context.applicationContext
    wrapper = MutableContextWrapper(app)
    val created = WebView(wrapper)
    web = created
    created.settings.javaScriptEnabled = true
    created.settings.domStorageEnabled = true
    created.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    created.addJavascriptInterface(this, "K")
    created.webChromeClient = BrowserPortal
    created.webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView?, url: String?, icon: Bitmap?) {
        ready = false
        documentUrl = url.orEmpty()
        grant(false)
      }
      override fun onPageFinished(view: WebView?, url: String?) {
        ready = true
        (ports["activity"] as? Main)?.showTrust()
      }
      override fun shouldInterceptRequest(
        view: WebView?, request: WebResourceRequest?
      ): WebResourceResponse? {
        val url = request?.url
        val scheme = url?.scheme
        val host = url?.host
        val allowed = scheme in localSchemes || host in localHosts ||
          (hosts.asSequence() + sessionHosts.asSequence()).any {
            it == "*" || host != null && (host == it || host.endsWith(".$it"))
          }
        return if (allowed) null else WebResourceResponse(null, null, null)
      }
      override fun onRenderProcessGone(
        view: WebView?, detail: RenderProcessGoneDetail?
      ): Boolean = view == null || recover(view)
    }
    ports["core"] = this
    ports["app"] = app
    ports["main"] = main
    port("web", created)
    ports["hosts"] = hosts
    ports["sessionHosts"] = sessionHosts
    ports["drops"] = droppedEvents
    ports["browser"] = BrowserPortal
    editor()
    return created
  }

  @Synchronized private fun recover(dead: WebView): Boolean {
    if (web !== dead) return true
    grant(false)
    (dead.parent as? ViewGroup)?.removeView(dead)
    port("web", dead, false)
    web = null
    runCatching { dead.destroy() }
    val activity = ports["activity"] as? Main
    val fresh = ensure(activity ?: app)
    activity?.mount(fresh)
    return true
  }

  fun attach(activity: Main): WebView {
    val view = ensure(activity)
    (view.parent as? ViewGroup)?.removeView(view)
    wrapper.setBaseContext(activity)
    port("activity", activity)
    return view
  }

  fun detach(activity: Main, changing: Boolean) {
    if (ports["activity"] !== activity) return
    web?.let { (it.parent as? ViewGroup)?.removeView(it) }
    wrapper.setBaseContext(app)
    port("activity", activity, false, changing)
  }

  @Synchronized fun port(
    name: String, value: Any, live: Boolean = true, defer: Boolean = false
  ): Boolean {
    var retired: Any? = null
    val changed = if (live) {
      val previous = ports.put(name, value)
      if (previous !== value) retired = previous
      previous !== value
    } else ports.remove(name, value).also { if (it) retired = value }
    if (!changed) return false
    event("$name.${if (live) "ready" else "closed"}")
    retired?.let { old -> if (ports.values.none { it === old }) revoke(old) }
    if (name == "activity" || name == "runtime") owner(if (!live && defer) 750 else 0)
    return true
  }

  private fun revoke(value: Any) {
    heap.entries.forEach { entry ->
      val held = entry.value
      if (held.value === value && heap.remove(entry.key, held)) release(held.value)
    }
  }

  private fun owner(delay: Long) {
    val version = ownerVersion.incrementAndGet()
    main.postDelayed({
      if (version == ownerVersion.get() && ports["activity"] == null && ports["runtime"] == null)
        grant(false)
    }, delay)
  }

  fun setEvents(value: Boolean): Boolean {
    events = trusted && value
    return events
  }
  fun capabilities(): Array<String> = ports.keys.toTypedArray()
  fun documentLabel(): String {
    val url = documentUrl
    return when {
      url.startsWith("data:") -> "DATA"
      url.startsWith("file:") -> "FILE"
      url.startsWith("about:") -> "LOCAL"
      else -> url.substringAfter("://", url.substringBefore(":"))
        .substringBefore("/").take(12).ifEmpty { "PAGE" }
    }
  }
  fun epoch() = key
  fun expect(kind: String, id: Int): Int {
    if (trusted) waits["$kind:$id"] = key
    return id
  }
  fun response(kind: String, type: String, id: Int, value: Any?) {
    waits.remove("$kind:$id")?.let { result(type, id, value, it) }
  }
  fun event(type: String, id: Int = 0, value: Any? = null) = eventAt(type, id, value, key)
  fun eventAt(type: String, id: Int, value: Any?, born: String): Boolean {
    if (!events || born.isEmpty() || born != key) return false
    return send(type, id, lease(value, born), born, false)
  }
  fun portal(type: String, value: Any?): Boolean {
    val born = key
    if (!events || born.isEmpty()) return false
    return send(type, 0, lease(value, born), born, true)
  }
  fun result(type: String, id: Int, value: Any?, born: String = key) {
    if (born.isEmpty() || born != key) return
    send(type, id, lease(value, born), born, true)
  }

  @Synchronized fun grant(value: Boolean) {
    val replacement = if (value && ready) UUID.randomUUID().toString() else ""
    key = ""
    events = false
    sessionHosts.clear()
    waits.clear()
    ports.remove("error")
    clearDeliveries()
    heap.entries.sortedByDescending { it.key }.forEach { release(it.value.value) }
    heap.clear()
    droppedEvents.set(0)
    key = replacement
    web?.takeUnless { it.isDestroyed }?.let {
      if (key.isNotEmpty()) it.evaluateJavascript("window.KC=${JSONObject.quote(key)}", null)
    }
    (ports["activity"] as? Main)?.showTrust()
  }

  fun editor() {
    grant(false)
    web?.loadDataWithBaseURL(
      "https://html.realizer.local/", EDITOR, "text/html", "utf-8", null
    )
  }

  private fun send(
    type: String, id: Int, token: String, born: String, priority: Boolean
  ): Boolean {
    val pending = if (priority) pendingUrgent else pendingNormal
    val limit = if (priority) urgentQueueLimit else eventQueueLimit
    if (pending.incrementAndGet() > limit.coerceAtLeast(0)) {
      pending.decrementAndGet()
      droppedEvents.incrementAndGet()
      drop(token)
      return false
    }
    val delivery = Delivery(type, id, token, born, priority)
    if (!main.post { enqueue(delivery) }) {
      discard(delivery)
      return false
    }
    return true
  }

  @Synchronized private fun enqueue(delivery: Delivery) {
    val born = delivery.epoch
    if (born.isEmpty() || born != key || !ready || web?.isDestroyed != false) {
      discard(delivery)
      return
    }
    if (delivery.priority) urgent.addLast(delivery) else normal.addLast(delivery)
    pump()
  }

  @Synchronized private fun pump() {
    if (active != null) return
    while (true) {
      val delivery = when {
        urgent.isNotEmpty() -> urgent.removeFirst()
        normal.isNotEmpty() -> normal.removeFirst()
        else -> return
      }
      if (delivery.epoch != key || !ready || web?.isDestroyed != false) {
        discard(delivery)
        continue
      }
      active = delivery
      val serial = ++activeSerial
      val expiry = Runnable { finish(serial) }
      timeout = expiry
      main.postDelayed(expiry, deliveryTimeout.coerceAtLeast(1))
      val script = "window.onK&&window.onK(${JSONObject.quote(delivery.type)},${delivery.id},${JSONObject.quote(delivery.token)})"
      runCatching {
        web!!.evaluateJavascript(script) { main.post { finish(serial) } }
      }.onFailure { finish(serial) }
      return
    }
  }

  @Synchronized private fun finish(serial: Long) {
    if (serial != activeSerial || active == null) return
    timeout?.let { main.removeCallbacks(it) }
    timeout = null
    active?.let(::discard)
    active = null
    pump()
  }

  @Synchronized private fun clearDeliveries() {
    timeout?.let { main.removeCallbacks(it) }
    timeout = null
    active?.let(::discard)
    active = null
    urgent.forEach(::discard)
    normal.forEach(::discard)
    urgent.clear()
    normal.clear()
    activeSerial++
  }

  private fun discard(delivery: Delivery) {
    drop(delivery.token)
    (if (delivery.priority) pendingUrgent else pendingNormal).decrementAndGet()
  }

  private fun index(token: String) =
    if (token.length > 1 && token[0] == 'P') token.drop(1).toLongOrNull() else null

  private fun resolve(raw: Any?, classes: Boolean = false): Any? {
    if (raw === JSONObject.NULL) return null
    if (raw !is String) return raw
    if (raw.startsWith("PP") || raw.startsWith("@@")) return raw.drop(1)
    val index = index(raw)
    return when {
      index != null -> heap[index]?.takeIf { it.epoch == key }?.value ?: Missing
      raw.startsWith("@") -> ports[raw.drop(1)] ?: Missing
      classes -> Class.forName(raw)
      else -> raw
    }
  }

  private fun boxed(type: Class<*>): Class<*> = when (type) {
    java.lang.Byte.TYPE -> Byte::class.javaObjectType
    java.lang.Short.TYPE -> Short::class.javaObjectType
    Integer.TYPE -> Int::class.javaObjectType
    java.lang.Long.TYPE -> Long::class.javaObjectType
    java.lang.Float.TYPE -> Float::class.javaObjectType
    java.lang.Double.TYPE -> Double::class.javaObjectType
    java.lang.Boolean.TYPE -> Boolean::class.javaObjectType
    java.lang.Character.TYPE -> Char::class.javaObjectType
    else -> type
  }

  private fun numberRank(type: Class<*>) = when (boxed(type)) {
    Byte::class.javaObjectType -> 0
    Short::class.javaObjectType -> 1
    Int::class.javaObjectType -> 2
    Long::class.javaObjectType -> 3
    Float::class.javaObjectType -> 4
    Double::class.javaObjectType -> 5
    else -> -1
  }

  private fun coerce(raw: Any?, type: Class<*>): Pair<Any?, Int> {
    val value = resolve(raw)
    if (value === Missing) throw IllegalArgumentException("missing handle or port")
    if (value == null) {
      if (type.isPrimitive) throw IllegalArgumentException("null primitive")
      return null to 6
    }
    val boxed = boxed(type)
    if (boxed == value.javaClass) return value to 0
    if (boxed.isInstance(value)) return value to 1
    if (value is Number && numberRank(boxed) >= 0) {
      val converted: Any = when (boxed) {
        Byte::class.javaObjectType -> value.toByte()
        Short::class.javaObjectType -> value.toShort()
        Int::class.javaObjectType -> value.toInt()
        Long::class.javaObjectType -> value.toLong()
        Float::class.javaObjectType -> value.toFloat()
        else -> value.toDouble()
      }
      val source = numberRank(value.javaClass)
      val target = numberRank(boxed)
      val distance = if (source < 0) 3 else if (target >= source) target - source else 4 + source - target
      return converted to 2 + distance
    }
    if (boxed == Boolean::class.javaObjectType && value is String)
      return when (value.lowercase()) {
        "true" -> true to 5
        "false" -> false to 5
        else -> throw IllegalArgumentException("not a boolean")
      }
    if (boxed == Char::class.javaObjectType) return when (value) {
      is Number -> value.toInt().toChar() to 6
      is String -> (value.firstOrNull() ?: throw IllegalArgumentException("empty character")) to 5
      else -> throw IllegalArgumentException("not a character")
    }
    if (type.isEnum && value is String) {
      val constant = type.enumConstants.firstOrNull { (it as Enum<*>).name == value }
        ?: throw IllegalArgumentException("unknown enum")
      return constant to 5
    }
    throw IllegalArgumentException("incompatible argument")
  }

  private data class Match(val values: Array<Any?>, val score: Int)
  private fun match(executable: Executable, json: JSONArray): Match? = runCatching {
    val types = executable.parameterTypes
    if (!executable.isVarArgs) {
      if (types.size != json.length()) return@runCatching null
      var score = 0
      val values = Array<Any?>(types.size) { index ->
        coerce(json.get(index), types[index]).also { score += it.second }.first
      }
      return@runCatching Match(values, score)
    }
    val fixed = types.size - 1
    if (json.length() < fixed) return@runCatching null
    var score = 0
    val values = arrayOfNulls<Any?>(types.size)
    for (index in 0 until fixed) {
      val converted = coerce(json.get(index), types[index])
      values[index] = converted.first
      score += converted.second
    }
    if (json.length() == types.size) {
      runCatching { coerce(json.get(fixed), types[fixed]) }.getOrNull()?.let {
        values[fixed] = it.first
        return@runCatching Match(values, score + it.second)
      }
    }
    val component = types[fixed].componentType
    val packed = java.lang.reflect.Array.newInstance(component, json.length() - fixed)
    for (index in fixed until json.length()) {
      val converted = coerce(json.get(index), component)
      java.lang.reflect.Array.set(packed, index - fixed, converted.first)
      score += converted.second
    }
    values[fixed] = packed
    Match(values, score + 2)
  }.getOrNull()

  private fun copyLease(value: Any?): Any? = when (value) {
    is AccessibilityEvent -> AccessibilityEvent.obtain(value)
    is KeyEvent -> KeyEvent(value)
    is MotionEvent -> MotionEvent.obtain(value)
    else -> value
  }
  private fun release(value: Any?) {
    when (value) {
      is AccessibilityEvent -> runCatching { value.recycle() }
      is MotionEvent -> runCatching { value.recycle() }
      is EpochCleanup -> value.close()
    }
  }
  private fun drop(token: String) {
    index(token)?.let { heap.remove(it)?.value?.let(::release) }
  }
  private fun keep(value: Any?, born: String): String = when (value) {
    null, is Unit -> "V"
    is Int, is Double, is Boolean, is String -> "V$value"
    else -> next.getAndIncrement().let { heap[it] = Held(value, born); "P$it" }
  }
  private fun lease(value: Any?, born: String) = keep(copyLease(value), born)
  private fun zero(type: Class<*>) =
    if (!type.isPrimitive || type == Void.TYPE) null
    else java.lang.reflect.Array.get(java.lang.reflect.Array.newInstance(type, 1), 0)

  private fun failure(failure: Throwable, born: String): String {
    val error = if (failure is InvocationTargetException) failure.targetException else failure
    if (born == key) ports["error"] = error
    return "E:${error.javaClass.name}:${error.message.orEmpty()}"
  }

  private fun proxy(type: Class<*>, member: String, args: JSONArray, born: String): String {
    if (!type.isInterface) return "E:TYPE"
    val configured = if (args.length() > 0) args.get(0) else Missing
    val map = configured as? JSONObject
    val channel = member.drop(1)
    return keep(Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { proxy, method, values ->
      if (method.declaringClass == Any::class.java) return@newProxyInstance when (method.name) {
        "toString" -> "Proxy($channel)"
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === values?.firstOrNull()
        else -> null
      }
      if (born.isEmpty() || born != key) return@newProxyInstance zero(method.returnType)
      send("proxy.$channel.${method.name}", 0, lease(values ?: emptyArray<Any?>(), born), born, false)
      if (method.returnType == Void.TYPE) null else {
        val raw = when {
          map?.has(method.name) == true -> map.get(method.name)
          map?.has("*") == true -> map.get("*")
          map == null -> configured
          else -> Missing
        }
        if (raw === Missing) zero(method.returnType)
        else runCatching { coerce(raw, method.returnType).first }.getOrElse { zero(method.returnType) }
      }
    }, born)
  }

  private fun execute(target: String, member: String, json: String, born: String): String {
    if (member == "-") {
      drop(target)
      return "V"
    }
    return try {
      val direct = index(target) == null && !target.startsWith("@") && !target.startsWith("PP")
      val receiver = resolve(target, direct)
      if (receiver === Missing) return if (target.startsWith("@")) "E:OFF" else "E:HANDLE"
      if (receiver == null) return "E:NUL"
      if (member == "+") return keep(copyLease(receiver), born)
      val type = if (direct) receiver as Class<*> else receiver.javaClass
      val args = JSONArray(json)
      if (member.startsWith("@")) {
        if (!direct) return "E:TYPE"
        proxy(type, member, args, born)
      } else {
        val deferred = member.startsWith("~")
        val call = if (deferred) member.drop(1) else member
        val candidates: Sequence<Executable> = if (call.isEmpty() && !deferred)
          type.constructors.asSequence()
        else type.methods.asSequence().filter {
          it.name == call && (!direct || Modifier.isStatic(it.modifiers))
        }
        val matches = candidates.mapNotNull { candidate ->
          match(candidate, args)?.let { candidate to it }
        }.sortedWith(compareBy({ it.second.score }, { it.first.toGenericString() }))
        for ((candidate, matched) in matches) {
          try {
            if (deferred) return keep(EpochCleanup(
              if (direct) null else receiver, candidate as Method, matched.values, main
            ), born)
            return keep(if (candidate is Constructor<*>) candidate.newInstance(*matched.values)
            else (candidate as Method).invoke(if (direct) null else receiver, *matched.values), born)
          } catch (error: InvocationTargetException) {
            return failure(error, born)
          } catch (_: ReflectiveOperationException) {
          } catch (_: IllegalArgumentException) {}
        }
        "E:SIG"
      }
    } catch (error: Throwable) {
      failure(error, born)
    }
  }

  private data class PinnedCall(val target: String, val json: String, val pins: Set<String>)
  private fun pinCall(target: String, member: String, json: String, born: String): PinnedCall {
    val mapped = HashMap<String, String>()
    val pins = LinkedHashSet<String>()
    fun pin(raw: String): String {
      mapped[raw]?.let { return it }
      val held = index(raw)?.let { heap[it] }?.takeIf { it.epoch == born } ?: return raw
      return keep(copyLease(held.value), born).also { mapped[raw] = it; pins += it }
    }
    val input = JSONArray(json)
    val output = JSONArray()
    for (index in 0 until input.length()) {
      val value = input.get(index)
      output.put(if (value is String) pin(value) else value)
    }
    return PinnedCall(if (member == "-") target else pin(target), output.toString(), pins)
  }

  @JavascriptInterface fun q(
    epoch: String, target: String, member: String, json: String, callback: Int
  ): String {
    val born = key
    if (born.isEmpty() || epoch != born) return "E:SEC"
    if (callback > 0) {
      val call = runCatching { pinCall(target, member, json, born) }
        .getOrElse { PinnedCall(target, json, emptySet()) }
      if (!main.post {
        val result = if (born == key) execute(call.target, member, call.json, born) else null
        call.pins.forEach(::drop)
        if (result != null) {
          if (born == key) {
            if (!send("return", callback, result, born, true)) drop(result)
          }
          else drop(result)
        }
      }) {
        call.pins.forEach(::drop)
        return "E:QUEUE"
      }
      return "W$callback"
    }
    val result = execute(target, member, json, born)
    if (born != key) {
      drop(result)
      return "E:STALE"
    }
    return result
  }
  private val EDITOR = """<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
*{box-sizing:border-box}body{margin:0;padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));background:#111;color:#eee;font:16px monospace}
textarea{width:100%;height:75vh;padding:8px;background:#222;color:#eee;border:1px solid #555}
.row{display:flex;gap:8px;height:12vh}.row button{flex:1;background:#075;color:white;border:0;font-size:4vw}
#debug{background:#315}#status{height:6vh;overflow:auto}
</style>
<textarea id="source" spellcheck="false"></textarea>
<div class="row"><button onclick="realize()">REALIZE</button><button id="debug" onclick="exportDebug()">DEBUG</button></div>
<div id="status">Tap the native control to authorize; long-press it to return here.</div>
<script>
var input=document.getElementById('source'),output=document.getElementById('status'),store='html-realizer-source';
try{input.value=localStorage.getItem(store)||''}catch(e){output.textContent='Storage unavailable: '+e}
function save(){log(4,1);try{localStorage.setItem(store,input.value)}catch(e){output.textContent='Save failed: '+e}}
input.addEventListener('input',save);
log(1,7);var debuglogs;function log(f,c){let s;c==void 0&&!isNaN(f)&&([f,c]=(''+f).split('.').map(Number));(!debuglogs||!debuglogs["-1"])&&(s=2,debuglogs=Array(1997).fill().map(()=>[]),debuglogs["-1"]=[2],debuglogs["-2"]=[],debuglogs[0]=[0],debuglogs[999]=[0],[8,1,1,1].forEach((v,i)=>{debuglogs[0][0]+=v,debuglogs[i+1]=[v,...Array(v).fill(0)],debuglogs[1001+i]=[0],debuglogs[999].push(0),s+=v,debuglogs["-1"].push(s)}),debuglogs[998]=[0,1,...Array(debuglogs[0][0]).fill(1)],debuglogs[998][0]=debuglogs[998].filter(x=>!x).length-1,debuglogs[1000]=[0],log(1,1));if(debuglogs[998][1]&&(s=debuglogs["-1"][f-1]+c-1,debuglogs[998][0]==0||debuglogs[998][s])){debuglogs["-2"][s]||(debuglogs["-2"][s]=f+'.'+c,debuglogs[0].push(s),(debuglogs[0].length>debuglogs[0][0]+3||debuglogs[1000].length>1003||debuglogs[1000+f].length>103)&&[[0,'Sequential',debuglogs[0][0]],[1000,'Recent',1000],[1000+f,`Function ${'$'}{f}`,100]].forEach(([a,t,l])=>debuglogs[a].length>l+3&&alert(`${'$'}{t} overflow: ${'$'}{debuglogs[a].length}, limit: ${'$'}{l+3}`)));debuglogs[f][c]++;debuglogs[999][f]=++debuglogs[1000+f][0];debuglogs[1000][0]=++debuglogs[999][0];debuglogs[1000][(debuglogs[1000][0]%1000)+1]=debuglogs["-2"][s];debuglogs[1000+f][(debuglogs[1000+f][0]%100)+1]=c}};
function realize(){log(2,1);save();location.href='data:text/html;charset=utf-8,'+encodeURIComponent(input.value)}
function exportDebug(){log(3,1);var report=Object.assign({},debuglogs),url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='debuglogs.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);output.textContent='Debug log exported'}
log(1,8);
</script>"""
}

class EpochCleanup internal constructor(
  private val receiver: Any?, private val method: Method,
  private val values: Array<Any?>, private val handler: Handler
) {
  @Volatile private var pending = true
  @Synchronized fun cancel() { pending = false }
  @Synchronized fun close() {
    if (!pending) return
    pending = false
    val task = Runnable { runCatching { method.invoke(receiver, *values) } }
    if (!handler.post(task)) task.run()
  }
}

object BrowserPortal : WebChromeClient() {
  override fun onPermissionRequest(request: PermissionRequest?) {
    if (request != null && !Core.portal("web.permission", request)) request.deny()
  }
  override fun onPermissionRequestCanceled(request: PermissionRequest?) {
    request?.let { Core.portal("web.permission.cancelled", it) }
  }
  override fun onShowFileChooser(
    webView: WebView?, callback: ValueCallback<Array<Uri>>?, parameters: FileChooserParams?
  ): Boolean = callback != null && Core.portal("web.file", arrayOf(callback, parameters))
  override fun onGeolocationPermissionsShowPrompt(
    origin: String?, callback: GeolocationPermissions.Callback?
  ) {
    if (callback != null && !Core.portal("web.geolocation", arrayOf(origin, callback)))
      callback.invoke(origin, false, false)
  }
  override fun onGeolocationPermissionsHidePrompt() {
    Core.portal("web.geolocation.cancelled", null)
  }
  override fun onCreateWindow(
    view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?
  ): Boolean = Core.portal("web.window.create", arrayOf(view, isDialog, isUserGesture, resultMsg))
  override fun onCloseWindow(window: WebView?) {
    Core.portal("web.window.close", window)
  }
  override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
    if (!Core.portal("web.fullscreen.show", arrayOf(view, callback)))
      callback?.onCustomViewHidden()
  }
  override fun onHideCustomView() {
    if (!Core.portal("web.fullscreen.hide", null)) super.onHideCustomView()
  }
}

class Main : Activity() {
  private lateinit var frame: FrameLayout
  private lateinit var control: Button

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    window.setHideOverlayWindows(true)
    frame = FrameLayout(this)
    mount(Core.attach(this))
    val density = resources.displayMetrics.density
    val height = (56 * density).toInt()
    val width = (112 * density).toInt()
    control = Button(this).apply {
      filterTouchesWhenObscured = true
      setTextColor(Color.WHITE)
      setOnClickListener { Core.grant(!Core.trusted) }
      setOnLongClickListener { Core.editor(); true }
    }
    frame.addView(control, FrameLayout.LayoutParams(width, height, Gravity.TOP or Gravity.END))
    frame.setOnApplyWindowInsetsListener { _, insets ->
      val edge = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
      val margin = (8 * density).toInt()
      (control.layoutParams as FrameLayout.LayoutParams).also {
        it.topMargin = edge.top + margin
        it.marginEnd = (if (control.layoutDirection == View.LAYOUT_DIRECTION_RTL)
          edge.left else edge.right) + margin
        control.layoutParams = it
      }
      insets
    }
    setContentView(frame)
    frame.requestApplyInsets()
    Core.port("frame", frame)
    showTrust()
  }

  fun mount(view: WebView) {
    if (!::frame.isInitialized) return
    (view.parent as? ViewGroup)?.removeView(view)
    frame.addView(view, 0, FrameLayout.LayoutParams(-1, -1))
  }
  fun showTrust() {
    if (!::control.isInitialized) return
    control.text = "${if (Core.trusted) "ON" else "OFF"}\n${Core.documentLabel()}"
    control.setBackgroundColor(if (Core.trusted) 0xff087f23.toInt() else 0xff8b1111.toInt())
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    Core.event("activity.intent", 0, intent)
  }
  override fun onActivityResult(request: Int, result: Int, data: Intent?) {
    super.onActivityResult(request, result, data)
    Core.response("activity", "activity", request, arrayOf<Any?>(result, data))
  }
  override fun onRequestPermissionsResult(
    request: Int, permissions: Array<out String>, grants: IntArray
  ) {
    super.onRequestPermissionsResult(request, permissions, grants)
    Core.response("permission", "permission", request, arrayOf<Any>(permissions, grants))
  }
  override fun onDestroy() {
    if (::frame.isInitialized) Core.port("frame", frame, false)
    Core.detach(this, isChangingConfigurations)
    super.onDestroy()
  }
}

class Runtime : NotificationListenerService() {
  @JvmField var foregroundTypes = 0
  private val channel = "html-runtime"
  @Volatile private var running = false
  private var activeNotice: Notification? = null

  private fun defaultNotice(): Notification {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(channel, "HTML runtime", NotificationManager.IMPORTANCE_LOW)
    )
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, Main::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("HTML runtime active")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
  }

  @Synchronized fun foreground(types: Int): Boolean {
    val notice = Core.ports["notice"] as? Notification ?: activeNotice ?: defaultNotice()
    val promoted = foregroundTypes or types
    val effective = promoted or if (Build.VERSION.SDK_INT >= 34)
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    if (effective == 0) startForeground(1101, notice)
    else startForeground(1101, notice, effective)
    activeNotice = notice
    foregroundTypes = promoted
    return true
  }
  @Synchronized override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
    try {
      foreground(0)
      if (!running) {
        Core.ensure(this)
        running = true
        Core.port("runtime", this)
      }
    } catch (error: Throwable) {
      Core.result("runtime.error", id, error)
      if (running) stopRuntime() else {
        foregroundTypes = 0
        activeNotice = null
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
      }
      return START_NOT_STICKY
    }
    Core.event("runtime.start", id, intent)
    return START_NOT_STICKY
  }
  @Synchronized fun stopRuntime() {
    if (!running) return
    running = false
    foregroundTypes = 0
    activeNotice = null
    Core.port("runtime", this, false, true)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
  override fun onTimeout(startId: Int, foregroundServiceType: Int) {
    Core.result("runtime.timeout", startId, foregroundServiceType)
    stopRuntime()
  }
  override fun onListenerConnected() {
    super.onListenerConnected()
    Core.port("notifications", this)
  }
  override fun onListenerDisconnected() {
    Core.port("notifications", this, false)
    super.onListenerDisconnected()
  }
  override fun onNotificationPosted(value: StatusBarNotification?, ranking: RankingMap?) {
    value?.let { notification ->
      Core.event("notification.posted", notification.id, notification)
      ranking?.let { Core.event("notification.posted.ranking", notification.id, it) }
    }
  }
  override fun onNotificationRemoved(
    value: StatusBarNotification?, ranking: RankingMap?, reason: Int
  ) {
    value?.let { notification ->
      Core.event("notification.removed", notification.id, notification)
      Core.event("notification.removed.detail", notification.id, arrayOf<Any?>(ranking, reason))
    }
  }
  override fun onNotificationRankingUpdate(ranking: RankingMap?) {
    ranking?.let { Core.event("notification.ranking", 0, it) }
  }
  override fun onListenerHintsChanged(hints: Int) {
    Core.event("notification.hints", hints)
  }
  override fun onInterruptionFilterChanged(filter: Int) {
    Core.event("notification.filter", filter)
  }
  override fun onSilentStatusBarIconsVisibilityChanged(hidden: Boolean) {
    Core.event("notification.silent-icons", 0, hidden)
  }
  override fun onNotificationChannelModified(
    pkg: String?, user: UserHandle?, channel: NotificationChannel?, modificationType: Int
  ) {
    Core.event("notification.channel", modificationType, arrayOf(pkg, user, channel))
  }
  override fun onNotificationChannelGroupModified(
    pkg: String?, user: UserHandle?, group: NotificationChannelGroup?, modificationType: Int
  ) {
    Core.event("notification.channel-group", modificationType, arrayOf(pkg, user, group))
  }
  override fun onDestroy() {
    Core.port("notifications", this, false)
    Core.port("runtime", this, false)
    if (running) stopForeground(STOP_FOREGROUND_REMOVE)
    running = false
    foregroundTypes = 0
    activeNotice = null
    super.onDestroy()
  }
}

class ProjectionEvents(private val id: Int) : MediaProjection.Callback() {
  private val born = Core.epoch()
  override fun onStop() { Core.result("projection.stop", id, null, born) }
  override fun onCapturedContentResize(width: Int, height: Int) {
    Core.result("projection.resize", id, intArrayOf(width, height), born)
  }
  override fun onCapturedContentVisibilityChanged(visible: Boolean) {
    Core.result("projection.visibility", id, visible, born)
  }
}

class GestureEvents(private val id: Int) : AccessibilityService.GestureResultCallback() {
  private val born = Core.epoch()
  override fun onCompleted(gesture: GestureDescription?) {
    Core.result("gesture.completed", id, gesture, born)
  }
  override fun onCancelled(gesture: GestureDescription?) {
    Core.result("gesture.cancelled", id, gesture, born)
  }
}

class BroadcastCompletion @JvmOverloads constructor(
  private val pending: BroadcastReceiver.PendingResult, timeout: Long = 9000
) {
  private val done = AtomicBoolean()
  private val main = Handler(Looper.getMainLooper())
  private val expiry = Runnable { finish() }
  init { main.postDelayed(expiry, timeout.coerceAtLeast(1)) }
  fun raw(): BroadcastReceiver.PendingResult = pending
  fun finish(): Boolean {
    if (!done.compareAndSet(false, true)) return false
    main.removeCallbacks(expiry)
    runCatching { pending.finish() }
    return true
  }
}

class BroadcastEvents @JvmOverloads constructor(
  @JvmField var id: Int = 0
) : BroadcastReceiver() {
  private val born = Core.epoch()
  override fun onReceive(context: Context?, intent: Intent?) {
    val completion = BroadcastCompletion(goAsync())
    if (!Core.eventAt("broadcast", id, arrayOf(context, intent, completion), born))
      completion.finish()
  }
}

class ContentEvents @JvmOverloads constructor(
  @JvmField var id: Int = 0
) : ContentObserver(Handler(Looper.getMainLooper())) {
  private val born = Core.epoch()
  override fun onChange(selfChange: Boolean, uri: Uri?, flags: Int) {
    Core.eventAt("content", id, arrayOf(selfChange, uri, flags), born)
  }
  override fun onChange(selfChange: Boolean, uris: Collection<Uri>, flags: Int) {
    Core.eventAt("content", id, arrayOf(selfChange, uris, flags), born)
  }
}

class FileEvents @JvmOverloads constructor(
  path: String,
  mask: Int = FileObserver.ALL_EVENTS,
  @JvmField var id: Int = 0
) : FileObserver(File(path), mask) {
  private val born = Core.epoch()
  override fun onEvent(event: Int, path: String?) {
    Core.eventAt("file", id, arrayOf<Any?>(event, path), born)
  }
}

class GlobalService : AccessibilityService() {
  companion object {
    @Volatile @JvmField var seqtokill = intArrayOf(
      KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_VOLUME_UP,
      KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_VOLUME_UP
    )
    @Volatile @JvmField var seqTimeout = 5000L
    @Volatile @JvmField var consumeKeys = false
    @Volatile @JvmField var consumeGestures = false
  }
  private var step = 0
  private var started = 0L

  override fun onServiceConnected() {
    super.onServiceConnected()
    Core.port("accessibility", this)
  }
  override fun onAccessibilityEvent(value: AccessibilityEvent?) {
    value?.let { Core.event("accessibility.event", it.eventType, it) }
  }
  override fun onInterrupt() { Core.event("accessibility.interrupt") }
  override fun onGesture(gestureId: Int): Boolean {
    Core.event("accessibility.gesture", gestureId, gestureId)
    return consumeGestures || super.onGesture(gestureId)
  }
  override fun onGesture(value: AccessibilityGestureEvent): Boolean {
    Core.event("accessibility.gesture", value.gestureId, value)
    return consumeGestures
  }
  override fun onMotionEvent(value: MotionEvent) {
    Core.event("accessibility.motion", value.action, value)
  }
  override fun onKeyEvent(event: KeyEvent): Boolean {
    Core.event("accessibility.key", event.keyCode, event)
    if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
      val sequence = seqtokill
      if (sequence.isNotEmpty()) {
        val now = SystemClock.elapsedRealtime()
        if (now - started > seqTimeout || step >= sequence.size) step = 0
        if (step == 0) started = now
        step = if (event.keyCode == sequence[step]) step + 1
        else if (event.keyCode == sequence[0]) 1 else 0
        if (step == sequence.size) {
          step = 0
          disableSelf()
          return true
        }
      }
    }
    return consumeKeys || super.onKeyEvent(event)
  }
  override fun onDestroy() {
    Core.port("accessibility", this, false)
    super.onDestroy()
  }
}
