#include <WiFi.h>
#include <WebServer.h>
#include <esp_wifi.h>
#include <math.h>
#define R return
#define C esp_wifi_set_
#define Z(v) if(v>3.14159)v-=6.28318;if(v<-3.14159)v+=6.28318
struct V{float x,p,a,o,lp,ld;int s,zc;};
struct L{uint32_t t;float p,v;};
struct F{float mn,mx;int pt;};
V m[64];L h[200];int hx=0;uint32_t T;bool Ld=0,Cmp=0;
WebServer S(80);int i;int8_t b[512];float l,d,cm,tm,iv,Q,al,av;F flt={0.5,50.0,5};
uint8_t pkt[]={0xc0,0x00,0x00,0x00,0xff,0xff,0xff,0xff,0xff,0xff,0x00,0x00,0x00,0x00,0x00,0x00,0xff,0xff,0xff,0xff,0xff,0xff,0x00,0x00};
const char* P=R"===(<body style="margin:0;background:#050505;color:#ccc;font-family:sans-serif;overflow:hidden">
<canvas id=c></canvas>
<div style="position:absolute;top:0;left:0;width:260px;padding:10px;background:rgba(0,0,0,0.9);border-bottom-right-radius:8px;font-size:12px;border:1px solid #333;border-left:0;border-top:0">
 <h3 style="margin:0 0 5px 0;color:#0f0">SENTINEL RADAR</h3>
 <div style="display:flex;justify-content:space-between;margin-bottom:5px">
  <span>STATUS: <b id=st style="color:#ff0">INIT</b></span>
  <span>LIVE MASS: <b id=ls style="color:#fff">0.0</b></span>
 </div>
 <div style="margin-bottom:10px">
  <button id=bm onclick="tC()" style="width:100%;padding:5px;background:#333;color:#fff;border:1px solid #555;cursor:pointer">MODE: ADAPTIVE</button>
 </div>
 <fieldset style="border:1px solid #444;margin-bottom:10px;padding:5px">
  <legend style="color:#0f0">FILTERS (0 = OFF)</legend>
  <div style="display:flex;justify-content:space-between;margin-bottom:4px">
   <span>MIN SIZE:</span><input id=imn value=0.5 style="width:50px;background:#222;color:#fff;border:0;text-align:center">
  </div>
  <div style="display:flex;justify-content:space-between;margin-bottom:4px">
   <span>MAX SIZE:</span><input id=imx value=50.0 style="width:50px;background:#222;color:#fff;border:0;text-align:center">
  </div>
  <div style="display:flex;justify-content:space-between">
   <span>FAN/OSC:</span><input id=ip value=5 style="width:50px;background:#222;color:#fff;border:0;text-align:center">
  </div>
  <button onclick="uF()" style="width:100%;margin-top:5px;background:#224;color:#fff;border:0;cursor:pointer;padding:4px">UPDATE FILTERS</button>
 </fieldset>
 <button id=ba onclick="tA()" style="width:100%;padding:8px;background:#300;color:#fff;border:1px solid #f00;font-weight:bold;cursor:pointer">ENABLE AUDIO</button>
</div>
<script>
let ctx=c.getContext('2d'),w,h,M=[],H=[],Rx=.5,Ry=.5,z=10,cp=0,ae=0,ac,lo=0,lt=0;
c.width=w=innerWidth;c.height=h=innerHeight;
function tC(){cp=!cp;fetch('/s?m='+(cp?1:0));bm.innerText='MODE: '+(cp?'ORIGINAL':'ADAPTIVE');bm.style.background=cp?'#005':'#333';}
function uF(){fetch(`/f?n=${imn.value}&x=${imx.value}&p=${ip.value}`);}
function tA(){ae=!ae;if(ae){ac=new(window.AudioContext||window.webkitAudioContext)();ba.innerText='AUDIO ARMED';ba.style.background='#050';ba.style.borderColor='#0f0';}else{ba.innerText='ENABLE AUDIO';ba.style.background='#300';ba.style.borderColor='#f00';}}
function bp(f){if(!ae)return;let o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.value=f;o.type='square';o.start();g.gain.setValueAtTime(.1,ac.currentTime);g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+0.1);o.stop(ac.currentTime+0.1);}
function P3(x,y,d){let c=Math.cos(Rx),s=Math.sin(Rx),dc=Math.cos(Ry),ds=Math.sin(Ry);let x1=x,y1=y*c-d*s,z1=y*s+d*c,x2=x1*dc-z1*ds,y2=y1,z2=x1*ds+z1*dc,f=400/(400+z2);return{x:w/2+x2*z*f,y:h/2+y2*z*f,s:f*5}}
setInterval(async()=>{
 let d=await(await fetch('/d')).json();M=d.m;H=d.h;st.innerText=d.s;ls.innerText=d.sz.toFixed(2);
 if(d.a&&ae){let now=Date.now(),diff=Math.abs(d.l-lo);
 if(diff>5||now-lt>500){lo=d.l;lt=now;bp(600+d.sz*10);}}
 ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);
 ctx.beginPath();ctx.strokeStyle='#f00';ctx.lineWidth=2;
 H.forEach((p,i)=>{let v=P3(i/3-30,-p.p*20,p.v*10);i?ctx.lineTo(v.x,v.y):ctx.moveTo(v.x,v.y)});ctx.stroke();
 M.forEach((v,i)=>{let p=P3(i-32,-v.x*30,0),cl=`rgba(0,255,0,${1-v.p})`;
 if(v.s==1)cl='#ff0';if(v.s==2)cl='#f00';if(v.s==3)cl='#0ff';
 ctx.fillStyle=cl;ctx.fillRect(p.x,p.y,p.s,p.s*5)})
},50);
onmousemove=e=>{if(e.buttons){Rx+=e.movementY*.01;Ry+=e.movementX*.01}}
onwheel=e=>{z-=e.deltaY*.01}
</script>)===";
void r(void*_,wifi_csi_info_t*o){if(o->len>256)R;memcpy(b,o->buf,o->len);l=0;cm=0;tm=0;
for(i=0;i<64;i++){float raw=atan2(b[i*2+1],b[i*2]);if(i){d=raw-l;Z(d);raw=m[i-1].x+d;}l=raw;
float delta=raw-m[i].lp;if((delta>0&&m[i].ld<0)||(delta<0&&m[i].ld>0))m[i].zc++;
if(m[i].zc>0&&rand()%10==0)m[i].zc--;m[i].lp=raw;m[i].ld=delta;
iv=raw-m[i].x;Q=iv*iv;if(Q>.5)Q=1.;else if(Q<.001)Q=1e-6;
m[i].p+=Q;float k=m[i].p/(m[i].p+.1);m[i].x+=k*iv;m[i].p=(1.-k)*m[i].p;
if(!Ld){m[i].a=m[i].x;m[i].o=m[i].x;m[i].s=0;}else{
if(flt.pt>0&&m[i].zc>flt.pt){m[i].s=3;continue;}
float rf=Cmp?m[i].o:m[i].a;float df=fabs(m[i].x-rf);
if(df>.5){m[i].s=(m[i].p<.01)?1:2;if(m[i].s==2){cm+=i*df;tm+=df;}}
else{m[i].s=0;if(!Cmp)m[i].a=m[i].a*.999+m[i].x*.001;}}}
av=0;if(Ld){if(flt.mn>0&&tm<flt.mn)tm=0;if(flt.mx>0&&tm>flt.mx)tm=0;
if(tm>0){float p=cm/tm,v=0;int lx=hx?hx-1:199;al=p;av=1;
if(h[lx].t>0){float dt=(millis()-h[lx].t)/1000.;if(dt>0)v=(p-h[lx].p)/dt;}
h[hx]={millis(),p,v};hx=(hx+1)%200;}}
void setup(){T=millis();WiFi.softAP("ESP32_SENTINEL","");
for(i=0;i<64;i++)m[i]={0,1,0,0,0,0,0,0};C csi_rx_cb(r,0);C csi(1);
wifi_csi_config_t c={1,1,1,1,0,0,0};C csi_config(&c);S.on("/",[](){S.send(200,"text/html",P);});
S.on("/s",[](){if(S.hasArg("m"))Cmp=S.arg("m").toInt();S.send(200,"text/plain","OK");});
S.on("/f",[](){if(S.hasArg("n"))flt.mn=S.arg("n").toFloat();if(S.hasArg("x"))flt.mx=S.arg("x").toFloat();
if(S.hasArg("p"))flt.pt=S.arg("p").toInt();S.send(200,"text/plain","OK");});
S.on("/d",[](){String j="{\"s\":\""+String(Ld?"ARMED":"LEARNING")+"\",\"sz\":"+String(tm)+",\"a\":"+String(av)+",\"l\":"+String(al)+",\"m\":[";
for(i=0;i<64;i++)j+=(i?",":"")+String("{\"x\":")+m[i].x+",\"p\":"+m[i].p+",\"s\":"+m[i].s+"}";j+="],\"h\":[";
int x=hx;for(int k=0;k<200;k++){if(h[x].t)j+=(k?",":"")+String("{\"t\":")+h[x].t+",\"p\":"+h[x].p+",\"v\":"+h[x].v+"}";
x=(x+1)%200;}S.send(200,"application/json",j+"]}");});S.begin();}
void loop(){S.handleClient();if(!Ld&&millis()-T>60000){Ld=1;for(i=0;i<64;i++)m[i].o=m[i].x;}
if(Ld){pkt[22]++;esp_wifi_80211_tx(WIFI_IF_AP,pkt,24,1);}delay(5);}
