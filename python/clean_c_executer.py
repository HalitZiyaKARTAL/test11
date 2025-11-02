try:
    with open("input_file_0.py", "w") as f:
        f.write(r"""import os,re,sys,subprocess
def compile_and_run(c_code,source_name):
 executable_name=f"delete_{os.path.splitext(os.path.basename(source_name))[0]}";temp_c_file="_temp_source.c"
 try:
  print(f"-> Compiling C code from '{source_name}'...")
  with open(temp_c_file,'w')as f:f.write(c_code)
  cp=subprocess.run(['gcc',temp_c_file,'-o',executable_name],capture_output=True,text=True)
  if cp.returncode!=0:
   print("\n"+"="*60);print("--- C COMPILATION FAILED ---");print(f"Source: {source_name}\n\n[GCC Compiler Error Message]");print(cp.stderr.strip());print("\n[Problematic Code with Line Numbers]")
   for i,line in enumerate(c_code.strip().splitlines(),1):print(f"{i: >3}: {line}")
   print("="*60);sys.exit(1)
  print("-> Compilation successful. Running program...")
  rp=subprocess.run([f'./{executable_name}'],check=True,capture_output=True,text=True)
  print("\n--- Program Output ---\n"+rp.stdout.strip()+"\n----------------------")
 finally:
  print("\n-> Cleaning up artifacts...")
  cl=False
  if os.path.exists(temp_c_file):os.remove(temp_c_file);cl=True
  if os.path.exists(executable_name):os.remove(executable_name);cl=True
  if cl:print("   Cleanup complete.")
def main():
 print("--- C Code Runner Initialized (Fallback Order: Auto > File > String) ---")
 args=sys.argv;num_cli_args=len(args)-1
 c_code, source_name = None, None
 if num_cli_args == 0 or num_cli_args > 2:
  files={int(m.group(1)):f for f in os.listdir('.') if(m:=re.match(r'input_file_(\d+)\.py',f))and int(m.group(1))!=0}
  if files:
   print("Mode: Automatic Discovery")
   source_name=files[max(files.keys())];print(f"Found target: '{source_name}'")
   with open(source_name, 'r') as f: c_code = f.read()
 elif num_cli_args == 1 and args[1] != '0' and os.path.exists(args[1]):
  source_name=args[1];print(f"Mode: Direct File Target ('{source_name}')")
  with open(source_name, 'r') as f: c_code = f.read()
 elif num_cli_args == 2 and args[1] == '0':
  print("Mode: Direct String Injection")
  c_code, source_name = args[2], "direct_string"
 if c_code is not None:
  compile_and_run(c_code, source_name)
 else:
  print("\nError: No action could be taken.",file=sys.stderr)
  print(" - Auto-discovery failed: No 'input_file_X.py' files found.",file=sys.stderr)
  print(" - Argument Error: Check arguments for File or String mode.",file=sys.stderr);sys.exit(1)
if __name__=="__main__":main()
""")
    with open("input_file_100.py", "w") as f:
        f.write('#include <stdio.h>\nint main(){printf("Result is: %d\\n",2+2);return 0;}')
    print("Successfully created 'input_file_0.py' and 'input_file_100.py'.")
    print("\nTo run the code, use one of the following commands:")
    print("1. (Auto-Search): python3 input_file_0.py")
    print("2. (Direct File): python3 input_file_0.py input_file_100.py")
    print("3. (Direct String): python3 input_file_0.py 0 '#include <stdio.h>\\nint main(){printf(\\\"Hello!\\n\\\");}'")
except IOError as e:
    print(f"An error occurred during file creation: {e}")
