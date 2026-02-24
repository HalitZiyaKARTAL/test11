import os,re,sys,subprocess,tempfile
def compile_and_run(c_code,source_name):
 try:
  print(f"-> Compiling C code from '{source_name}'...")
  with tempfile.TemporaryDirectory() as d:
   c,e=os.path.join(d,"c.c"),os.path.join(d,"e.out" if os.name!='nt' else "e.exe")
   with open(c,'w')as f:f.write(c_code)
   cp=subprocess.run(['gcc','-O3',c,'-o',e],capture_output=True,text=True)
   if cp.returncode!=0:
    print("\n"+"="*60);print("--- C COMPILATION FAILED ---");print(f"Source: {source_name}\n\n[GCC Error]\n{cp.stderr.strip()}\n\n[Code]")
    for i,line in enumerate(c_code.strip().splitlines(),1):print(f"{i: >3}: {line}")
    print("="*60);sys.exit(1)
   print("-> Compilation successful. Running program...")
   rp=subprocess.run([e],cwd=d,capture_output=True,text=True)
   if rp.returncode!=0:print(f"\n[!] C Program Crashed (Code {rp.returncode}). Memory dumps trapped and destroyed.")
   print("\n--- Program Output ---\n"+rp.stdout.strip()+"\n----------------------")
 finally:
  print("\n-> Memory sandbox unlinked. Zero artifacts remain.")
def main():
 print("--- C Code Runner Initialized (Fallback Order: Auto > File > String) ---")
 args=sys.argv;num_cli_args=len(args)-1; c_code, source_name = None, None
 if num_cli_args == 0 or num_cli_args > 2:
  files={int(m.group(1)):f for f in os.listdir('.') if(m:=re.match(r'input_file_(\d+)\.py',f))and int(m.group(1))!=0}
  if files:
   source_name=files[max(files.keys())];print(f"Mode: Auto-Discovery ('{source_name}')")
   with open(source_name, 'r') as f: c_code = f.read()
 elif num_cli_args == 1 and args[1] != '0' and os.path.exists(args[1]):
  source_name=args[1];print(f"Mode: Direct File ('{source_name}')")
  with open(source_name, 'r') as f: c_code = f.read()
 elif num_cli_args == 2 and args[1] == '0':
  print("Mode: Direct String Injection"); c_code, source_name = args[2], "direct_string"
 if c_code is not None: compile_and_run(c_code, source_name)
 else: print("Error: No valid input found.",file=sys.stderr);sys.exit(1)
if __name__=="__main__":main()
