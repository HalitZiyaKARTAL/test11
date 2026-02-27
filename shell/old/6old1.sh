askai() {
    
    local D="${TMPDIR:-/tmp}/g_ai"; mkdir -p "$D" 2>/dev/null && chmod 700 "$D" || { echo "Error: Failed to secure $D" >&2; return 1; }
    if ! command -v jq >/dev/null || ! command -v curl >/dev/null; then 
        echo -e "\033[1;31mError: Missing curl or jq.\033[0m" >&2; return 1
    fi

  
    local BF="$D/b.json" STF="$D/stream.txt" IDF="$D/id.txt" KF="$D/k.txt" AF="$D/a.txt" MF="$D/m.txt" CF="$D/c.txt"
    ([ -f "$BF" ] && ! jq . "$BF" >/dev/null 2>&1) && echo "{}" > "$BF"; [ ! -f "$BF" ] && echo "{}" > "$BF"
    [ -f "$STF" ] && [ "$(cat "$STF")" != "1" ] && echo "0" > "$STF"
    [ -f "$CF" ] && [ "$(cat "$CF")" != "1" ] && echo "0" > "$CF"
    
    local chat_id="default"; if [ -f "$IDF" ]; then local ri=$(cat "$IDF"); local ci=$(echo "$ri"|sed 's/[^a-zA-Z0-9_-]//g'); [ -n "$ci" ] && chat_id="$ci" || echo "default" > "$IDF"; fi
    local M="gemini-flash-latest"; [ -s "$MF" ] && M=$(cat "$MF") 

    
    local k="" n=0 s="" mo=0 mv="" show_all=0 stream_mode=0 select_id=0 del_mode=0 manage_key=0
    local arg_id="" arg_m="" arg_k="" p=""
    local interactive=1; local has_pipe=0; [ ! -t 0 ] && has_pipe=1
    
    
    local continuous=0; [ -f "$CF" ] && [ "$(cat "$CF")" == "1" ] && continuous=1

    
    if [ "$#" -eq 0 ] && [ "$has_pipe" -eq 0 ]; then 
        echo -e "\033[1;33mUsage:\033[0m askai [flags] <prompt>" >&2
        echo -e "\033[1;36mContext:\033[0m ID=[$chat_id] | Model=[$M]" >&2
        echo -e "\033[1;37mSession Flags:\033[0m" >&2
        echo -e "  -n               : New Chat Menu (Clear/Rename)" >&2
        echo -e "  -id [chat_name]  : Switch/Edit Chat Session" >&2
        echo -e "  -d               : Delete History Menu" >&2
        echo -e "\033[1;37mConfig Flags:\033[0m" >&2
        echo -e "  -m [model_name]  : Select/Edit Model (Empty to list)" >&2
        echo -e "  -k [api_key]     : Set/Manage API Key" >&2
        echo -e "  -s [sys_prompt]  : Set System Instruction (Persona)" >&2
        echo -e "  -c, --continuous : Toggle/Set Continuous Mode" >&2
        echo -e "  --stream         : Toggle/Set Streaming Output" >&2
        echo -e "\033[1;37mAdvanced:\033[0m" >&2
        echo -e "  -pipe hard       : Disable interactive menus (Automation)" >&2
        return 0
    fi

    while [[ "$#" -gt 0 ]]; do case "$1" in 
        -c|--continuous) if [[ "$#" -eq 1 && -z "$p" ]]; then
             if [ "$interactive" -eq 0 ]; then echo "Error: -c menu requires interaction" >&2; return 1; fi
             echo -e "\033[1;34m--- Continuous Settings ---\033[0m\n1) Enable Always (Default)\n2) Enable Once (This session)\n3) Disable Default\n0) Abort" >&2
             read -p "Choice > " c < /dev/tty
             case "$c" in 1) echo "1" > "$CF"; return 0;; 2) continuous=1; return 0;; 3) echo "0" > "$CF"; return 0;; *) return 0;; esac
        else continuous=1; shift; fi;;
        --stream) if [[ "$#" -eq 1 && -z "$p" ]]; then 
             if [ "$interactive" -eq 0 ]; then echo "Error: --stream menu requires interaction" >&2; return 1; fi
             echo -e "\033[1;34m--- Stream Settings ---\033[0m\n1) Enable Always\n2) Enable Once (Next msg)\n0) Abort" >&2
             read -p "Choice > " c < /dev/tty; [ "$c" = "1" ] && echo "1" > "$STF"; [ "$c" = "2" ] && stream_mode=1; return 0
        else stream_mode=1; shift; fi;;
        -pipe) if [[ "$2" == "hard" ]]; then interactive=0; shift 2; else echo "Error: -pipe requires 'hard'" >&2; return 1; fi;;
        -k|--key) if [[ -n "$2" && ! "$2" =~ ^- ]]; then arg_k="$2"; shift 2; else manage_key=1; shift; fi;;
        -id|--id) if [[ -n "$2" && ! "$2" =~ ^- ]]; then arg_id="$2"; shift 2; else select_id=1; shift; fi;;
        -n) n=1; shift;;
        -d|--delete) del_mode=1; shift;;
        -s) if [[ -n "$2" ]]; then s="$2"; shift 2; else echo "Error: -s missing arg" >&2; return 1; fi;;
        -m) mo=1; if [[ -n "$2" && ! "$2" =~ ^- ]]; then arg_m="$2"; shift 2; else shift; fi;;
        -1) show_all=1; shift;;
        *) p="${p:+$p }$1"; shift;;
    esac; done

    
    require_interaction() {
        if [ "$interactive" -eq 0 ]; then echo -e "\033[1;31mError: $1 requires interaction (blocked by -pipe hard).\033[0m" >&2; return 1; fi
    }

    
    if [ "$manage_key" -eq 1 ]; then 
        require_interaction "Key Manager" || return 1
        local ck="None"; [ -s "$KF" ] && ck="...$(cat "$KF" | tail -c 5)"; local ca="Off"; [ "$(cat "$AF" 2>/dev/null)" = "1" ] && ca="On"
        echo -e "\033[1;33m--- Key Manager ---\033[0m\nStored Key: $ck\nAuto-Use:   $ca\n1) Update/Set Key (Permanent)\n2) Toggle Auto-Use\n3) Use Key Once (Temp)\n0) Abort" >&2
        read -p "Choice > " kc < /dev/tty; case "$kc" in 
            1) read -s -p "Enter New Key: " nk < /dev/tty; echo >&2; echo "$nk" > "$KF"; echo 1 > "$AF"; echo "Key saved." >&2; return 0;; 
            2) if [ "$ca" == "On" ]; then echo 0 > "$AF"; echo "Auto-Use OFF" >&2; else echo 1 > "$AF"; echo "Auto-Use ON" >&2; fi; return 0;; 
            3) read -s -p "Enter Temp Key: " arg_k < /dev/tty; echo >&2;; 
            *) return 0;; 
        esac
    fi

    if [ "$del_mode" -eq 1 ]; then 
        require_interaction "Delete Menu" || return 1
        echo -e "\033[1;31m--- Delete Menu ---\033[0m\n1) Delete ALL histories\n2) Delete Current ID [$chat_id]\n0) Abort" >&2
        read -p "Choice > " dc < /dev/tty; case "$dc" in 
            1) rm -f "$D"/h_*.json; echo "All histories deleted." >&2; return 0;; 
            2) rm -f "$D/h_${chat_id}.json"; echo "Deleted $chat_id." >&2; chat_id="default"; echo "default" > "$IDF"; return 0;; 
            *) return 0;; 
        esac
    fi

    if [ "$n" -eq 1 ]; then 
        require_interaction "New Chat Wizard" || return 1
        while true; do 
            read -p "Enter Chat ID for New Session: " nid < /dev/tty; local clean_nid=$(echo "$nid"|sed 's/[^a-zA-Z0-9_-]//g')
            [ -z "$clean_nid" ] && continue
            if [ -f "$D/h_${clean_nid}.json" ]; then 
                echo -e "\033[1;33mID '$clean_nid' exists.\033[0m\n1) Overwrite\n2) New Name\n3) Rename Old\n0) Abort" >&2
                read -p "> " nc < /dev/tty; case "$nc" in 
                    1) chat_id="$clean_nid"; rm -f "$D/h_${chat_id}.json"; echo "$chat_id" > "$IDF"; break;; 
                    2) continue;; 
                    3) read -p "Rename old to: " old_name < /dev/tty; mv "$D/h_${clean_nid}.json" "$D/h_${old_name}.json"; chat_id="$clean_nid"; echo "$chat_id" > "$IDF"; break;; 
                    *) return 0;; 
                esac
            else chat_id="$clean_nid"; echo "$chat_id" > "$IDF"; break; fi
        done
    fi

    if [ -n "$arg_id" ]; then if [ -z "$p" ] && [ "$has_pipe" -eq 0 ]; then 
        require_interaction "ID Selector" || return 1
        local stat="New"; [ -f "$D/h_${arg_id}.json" ] && stat="Exists"
        echo -e "\033[1;33mProperty: Chat ID = '$arg_id' ($stat)\033[0m\n1) Set as Default\n2) Use Temporarily\n0) Abort" >&2
        read -p "Choice > " c < /dev/tty; case "$c" in 1) chat_id="$arg_id"; echo "$chat_id" > "$IDF";; 2) chat_id="$arg_id";; *) return 0;; esac
    else chat_id="$arg_id"; fi; fi

    if [ "$select_id" -eq 1 ]; then 
        require_interaction "Session List" || return 1
        while true; do 
            echo -e "\033[1;34m--- Chat Sessions ---\033[0m" >&2
            local fl=("$D"/h_*.json); local ids=(); local i=1
            if [ -e "${fl[0]}" ]; then for f in "${fl[@]}"; do local nm=$(basename "$f"|sed 's/^h_//;s/\.json$//'); ids+=("$nm"); echo "$i) $nm $([ "$nm" == "$chat_id" ] && echo "(*)")" >&2; ((i++)); done; else echo "(No saved histories)" >&2; fi
            echo "+) Create New Chat ID" >&2; echo "0) Abort" >&2; read -p "Select > " sel < /dev/tty
            local pk=""; if [[ "$sel" == "0" ]]; then return 0; elif [[ "$sel" == "+" ]]; then read -p "Enter New Name: " nn < /dev/tty; pk=$(echo "$nn"|sed 's/[^a-zA-Z0-9_-]//g'); [ -z "$pk" ] && continue; elif [[ "$sel" =~ ^[0-9]+$ && "$sel" -le "${#ids[@]}" && "$sel" -gt 0 ]]; then pk="${ids[$((sel-1))]}"; else continue; fi
            echo -e "\033[1;33mSelected: $pk\033[0m\n1) Set as Default\n2) Use Temporarily\n3) Pick Another\n0) Abort" >&2
            read -p "Choice > " sc < /dev/tty; case "$sc" in 1) chat_id="$pk"; echo "$chat_id" > "$IDF"; break;; 2) chat_id="$pk"; break;; 3) continue;; *) return 0;; esac
        done
    fi

    
    local HF="$D/h_${chat_id}.json"; local SF="$D/s_${chat_id}.txt"
    [ ! -f "$HF" ] && echo "[]" > "$HF"; [ ! -f "$SF" ] && touch "$SF"
    if [ -f "$HF" ] && ! jq . "$HF" >/dev/null 2>&1; then echo "[]" > "$HF"; fi 

    if [ -n "$arg_k" ]; then if [ -z "$p" ] && [ "$has_pipe" -eq 0 ]; then 
        require_interaction "Key Confirm" || return 1
        echo -e "\033[1;33mProperty: API Key = '...${arg_k: -4}'\033[0m\n1) Save as Default\n2) Use Temporarily\n0) Abort" >&2
        read -p "Choice > " c < /dev/tty; case "$c" in 1) k="$arg_k"; echo "$k" > "$KF"; echo 1 > "$AF";; 2) k="$arg_k";; *) return 0;; esac
    else k="$arg_k"; fi; fi

    if [ -z "$k" ]; then 
        if [ -s "$KF" ] && [ "$(cat "$AF" 2>/dev/null)" = "1" ]; then k=$(cat "$KF"); 
        else 
            require_interaction "API Key Setup" || return 1
            read -s -p "Enter Gemini API Key: " k < /dev/tty; echo >&2; echo "$k" > "$KF"; echo 1 > "$AF"; 
        fi
    fi

    if [ -n "$arg_m" ]; then if [ -z "$p" ] && [ "$has_pipe" -eq 0 ]; then 
        require_interaction "Model Confirm" || return 1
        echo -e "\033[1;33mProperty: Model = '$arg_m'\033[0m\n1) Set as Default\n2) Use Temporarily\n0) Abort" >&2
        read -p "Choice > " c < /dev/tty; case "$c" in 1) M="$arg_m"; echo "$M" > "$MF";; 2) M="$arg_m";; *) return 0;; esac
    else M="$arg_m"; fi; fi

    if [ "$mo" -eq 1 ] && [ -z "$arg_m" ]; then 
        require_interaction "Model List" || return 1
        while true; do 
            echo -e "\033[1;30mFetching models for '$chat_id'...\033[0m" >&2
            local jm=$(curl -s -H "x-goog-api-key: $k" "https://generativelanguage.googleapis.com/v1beta/models")
            local bk=$(cat "$BF"); local kh=$(echo "$k"|cksum|cut -d' ' -f1); 
            local jq_sort='
            .models[] 
            | select(.supportedGenerationMethods[]? | contains("generateContent")) 
            | .name |= sub("^models/"; "") 
            | .score = 0 
            | if (.name | contains("-pro")) then .score += 1000 elif (.name | contains("-flash")) then .score += 800 elif (.name | contains("-lite")) then .score += 600 else . end 
            | if (.name | test("gemini-[0-9]\\.[0-9]")) then .score += ((.name | capture("gemini-(?<v>[0-9]\\.[0-9])").v | tonumber) * 100) else . end 
            | if (.name | contains("-latest")) then .score += 10000 
              elif (.name | contains("-exp")) then .score += -5000 
              elif (.name | contains("-preview")) then 
                  if (.name | test("preview-[0-9]{2}-[0-9]{2}")) then .score += -2000 else .score += 500 end
              else .score += 5000 end 
            | if (.name | test("gemma|learnlm|tts|image|robotics|computer-use|thinking")) then .score += -50000 else . end
            | select($a=="1" or (.name as $n | ($bk[$h]//[]) | index($n) | not))
            | {name: .name, score: .score}
            '
            local ml=($(echo "$jm"|jq -r --arg h "$kh" --arg a "$show_all" --argjson bk "$bk" "$jq_sort" | jq -s 'sort_by(.score) | reverse | .[].name'))
            local hc=$(echo "$bk"|jq -r --arg h "$kh" '.[$h]//[]|length'); local i=1; for md in "${ml[@]}"; do echo "$i) $md" >&2; ((i++)); done
            echo "-1) list 0 limit models too, currently $hc" >&2
            read -p "Select Model (1-${#ml[@]}, 0 to Abort): " sl < /dev/tty
            if [ "$sl" == "-1" ]; then show_all=$((1-show_all)); continue; fi; [ "$sl" = "0" ] && return 0
            if [[ "$sl" =~ ^[0-9]+$ && "$sl" -le "${#ml[@]}" ]]; then 
                local sel="${ml[$((sl-1))]}"; echo -e "\033[1;33mModel: $sel\033[0m\n1) Save as Default\n2) Use Once\n3) Cancel (Keep $M)\n4) Retry" >&2
                read -p "Choice > " sc < /dev/tty; case "$sc" in 1) M="$sel"; echo "$M" > "$MF"; break;; 2) M="$sel"; break;; 3) break;; 4) continue;; *) return 0;; esac
            fi
        done
    fi

    [ -n "$s" ] && echo "$s" > "$SF"

    
    if [ "$has_pipe" -eq 1 ] && [ -z "$p" ]; then p="$(cat)"; fi

  
    while true; do
        if [ -z "$p" ]; then 
            if [ "$continuous" -eq 1 ]; then
                echo -e "\033[1;34m> (Paste/Type then Ctrl+D to send)\033[0m" >&2
                p=$(cat < /dev/tty)
                [ -z "$p" ] && return 0
            else
                require_interaction "Empty Prompt" || return 1
                read -p "Prompt > " p < /dev/tty
                [ -z "$p" ] && return 0
            fi
        fi

        
        local h_chars=$(jq -r '[.[].parts[].text // ""] | join("") | length' "$HF")
        local h_tok=$((h_chars / 4))
        local msg_n=$(jq 'length + 1' "$HF")
        local n_chars=${#p}
        local n_tok=$((n_chars / 4))
        
        local ts=$(date -u +"%Y%m%d_%H%M%Sutc")
        local sys_stat=""; [ -s "$SF" ] && sys_stat=" system:loaded"
        echo -e "\033[1;30mid:$chat_id message:$msg_n timestamp:$ts tokens:${h_tok}+${n_tok} model:$M$sys_stat\033[0m" >&2

        if ! jq --arg t "$p" '.+[{"role":"user","parts":[{"text":$t}]}]' "$HF" > "${HF}.t"; then 
            echo "Error: History corrupted. Resetting..." >&2; echo "[]" > "$HF"
            if ! jq --arg t "$p" '.+[{"role":"user","parts":[{"text":$t}]}]' "$HF" > "${HF}.t"; then echo "Fatal: Cannot write to history." >&2; return 1; fi
        fi; mv "${HF}.t" "$HF"

        local st=$(cat "$SF")
        local PF="$D/payload.json"
        jq -n --slurpfile h "$HF" --arg s "$st" \
           '{contents:$h[0]}+(if($s|length>0)then{system_instruction:{parts:[{text:$s}]}}else{}end)' > "$PF"

        local ft=""; local us="0"; ([ -f "$STF" ] && [ "$(cat "$STF")" == "1" ]) && us="1"; [ "$stream_mode" -eq 1 ] && us=1
        echo -e "\033[1;32m🤖 Gemini ($chat_id):\033[0m" >&2

        handle_err() { 
            echo -e "\n\033[1;31m❌ API Error:\033[0m $1" >&2
            jq 'del(.[-1])' "$HF" > "${HF}.t" && mv "${HF}.t" "$HF"
            if [[ "$1" == *"limit: 0"* ]]; then 
                echo -e "\033[1;33m⚠️  Quota Exceeded (Limit 0). Blocking '$M'.\033[0m" >&2
                local kh=$(echo "$k"|cksum|cut -d' ' -f1); jq --arg k "$kh" --arg m "$M" '.[$k]+=[$m]|.[$k]|=unique' "$BF" > "${BF}.t" && mv "${BF}.t" "$BF"
            fi 
        }

        if [ "$us" == "1" ]; then 
            local RO="$D/r.tmp"; > "$RO"
            curl -s -N -X POST "https://generativelanguage.googleapis.com/v1beta/models/$M:streamGenerateContent?alt=sse" \
                -H "x-goog-api-key: $k" -H "Content-Type: application/json" -d "@$PF" | \
            while IFS= read -r ln; do 
                if [[ "$ln" == "data: "* ]]; then 
                    local ct=$(echo "${ln#data: }"|jq -r '.candidates[0].content.parts[0].text//empty')
                    [ -n "$ct" ] && printf "%s" "$ct" | tee -a "$RO"
                    local se=$(echo "${ln#data: }"|jq -r '.error.message//empty'); [ -n "$se" ] && echo "$se" > "$D/e.tmp"
                fi
            done
            echo "" >&2; if [ -f "$D/e.tmp" ]; then handle_err "$(cat "$D/e.tmp")"; rm "$D/e.tmp"; return 1; fi
            ft=$(cat "$RO")
        else
            local r=$(curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/$M:generateContent" \
                -H "x-goog-api-key: $k" -H "Content-Type: application/json" -d "@$PF")
            local er=$(echo "$r" | jq -r '.error.message // empty'); if [ -n "$er" ]; then handle_err "$er"; return 1; fi
            ft=$(echo "$r" | jq -r '.candidates[0].content.parts[0].text // empty'); printf "%s\n" "$ft"
        fi

        [ -n "$ft" ] && jq --arg t "$ft" '.+[{"role":"model","parts":[{"text":$t}]}]' "$HF" > "${HF}.t" && mv "${HF}.t" "$HF"

        if [ "$continuous" -eq 0 ]; then break; fi
        p="" 
    done
}
