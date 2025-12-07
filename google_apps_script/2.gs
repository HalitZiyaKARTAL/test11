function auto_share_for_connected_ai_studio(){
var force_full_check=0;
var p=PropertiesService.getScriptProperties();
var k="T_V8";
var r=p.getProperty(k);
var qt="1970-01-01T00:00:00.000Z";
if(r&&force_full_check===0)qt=r;
var st=qt;
var f=DriveApp.getFoldersByName("Google AI Studio");
var m=["2@gmail.com","3@gmail.com","4@gmail.com","5@gmail.com","6@gmail.com"];
while(f.hasNext()){
var fid=f.next().getId(),page;
do{
var res=Drive.Files.list({q:"'"+fid+"' in parents and createdTime > '"+qt+"' and trashed = false",orderBy:"createdTime",fields:"nextPageToken, files(id, createdTime, permissions(emailAddress))",pageToken:page});
var list=res.files;
if(!list||list.length===0)break;
for(var i=0;i<list.length;i++){
var item=list[i],cur=[];
if(item.permissions)for(var j=0;j<item.permissions.length;j++)cur.push(item.permissions[j].emailAddress);
var add=[];
for(var x=0;x<m.length;x++)if(cur.indexOf(m[x])<0)add.push(m[x]);
if(add.length>0)DriveApp.getFileById(item.id).addEditors(add);
if(item.createdTime>st)st=item.createdTime;
}
page=res.nextPageToken;
}while(page);
}
if(st!==qt)p.setProperty(k,st);
}
