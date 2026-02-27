askai() {
    type ai >/dev/null 2>&1 || ai() { askai "$@"; }

    local CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/askai"
    local PATH_FILE="$CONF_DIR/.path"
    local D="${TMPDIR:-/tmp}/g_ai"
    local API="https://generativelanguage.googleapis.com/v1beta/models"
    
    if [ -s "$PATH_FILE" ]; then 
        read -r SAVED_D < "$PATH_FILE"
        if [ -d "$SAVED_D" ] && [ -w "$SAVED_D" ]; then 
            D="$SAVED_D"
        else 
            echo -e "\033[1;33mWarning: Persistent path '$SAVED_D' inaccessible. Falling back to $D\033[0m" >&2
        fi
    fi

    mkdir -p "$D" 2>/dev/null && chmod 700 "$D" || { echo "Error: Failed to secure $D" >&2; return 1; }

    if ! command -v jq >/dev/null || ! command -v curl >/dev/null; then 
        echo -e "\033[1;31mError: Missing curl or jq.\033[0m" >&2; return 1
    fi

    local PF RO
    PF=$(mktemp "$D/payload.XXXXXX.json") || { echo "Error: mktemp failed" >&2; return 1; }
    RO=$(mktemp "$D/r.XXXXXX.tmp")        || { rm -f "$PF"; echo "Error: mktemp failed" >&2; return 1; }

    local ERR_TMP="" pipe_smart=0
    local MACRO_Q=()

    trap 'rm -f "$PF" "$RO" "${ERR_TMP}" "$D"/slice.*.json 2>/dev/null; unset -f require_interaction handle_err _rollback_last _display_history _chat_submenu _ui_read 2>/dev/null' RETURN

    _ui_read() {
        local is_sec=0
        [ "$1" == "-s" ] && { is_sec=1; shift; }
        local __v=$1 __p=$2 val=""
        
        if [ ${#MACRO_Q[@]} -gt 0 ]; then
            val="${MACRO_Q[0]}"
            MACRO_Q=("${MACRO_Q[@]:1}") 
            [ "$is_sec" -eq 1 ] && echo -e "${__p}\033[1;35m***\033[0m (macro)" >&2 || echo -e "${__p}\033[1;35m${val}\033[0m (macro)" >&2
            printf -v "$__v" "%s" "$val"
            return 0
        fi
        
        if [ "$pipe_smart" -eq 1 ] && [ ! -t 0 ]; then
            if [ "$__p" == "Prompt > " ]; then
                val=$(cat)
                if [ -n "$val" ]; then
                    echo -e "${__p}\033[1;35m(read from stream)\033[0m" >&2
                    printf -v "$__v" "%s" "$val"
                    return 0
                fi
            else
                if IFS= read -r val; then
                    [ "$is_sec" -eq 1 ] && echo -e "${__p}\033[1;35m***\033[0m (smart)" >&2 || echo -e "${__p}\033[1;35m${val}\033[0m (smart)" >&2
                    printf -v "$__v" "%s" "$val"
                    return 0
                fi
            fi
        fi
        
        if [ "$interactive" -eq 0 ]; then 
            echo -e "\n\033[1;31mError: Interaction required.\033[0m" >&2; return 1
        fi
        
        if [ "$is_sec" -eq 1 ]; then 
            read -s -p "$__p" val < /dev/tty; echo >&2
        else 
            read -p "$__p" val < /dev/tty
        fi
        printf -v "$__v" "%s" "$val"
    }

    require_interaction() {
        if [ "$interactive" -eq 0 ]; then echo -e "\033[1;31mError: $1 requires interaction (blocked by -pipe hard).\033[0m" >&2; return 1; fi
    }

    _rollback_last() {
        local hf_tmp_rb
        hf_tmp_rb=$(mktemp "$D/h.XXXXXX.json") && jq 'del(.[-1])' "$HF" > "$hf_tmp_rb" && mv "$hf_tmp_rb" "$HF"
    }

    handle_err() { 
        echo -e "\n\033[1;31m❌ API Error:\033[0m $1" >&2
        local hf_tmp
        hf_tmp=$(mktemp "$D/h.XXXXXX.json") && jq 'del(.[-1])' "$HF" > "$hf_tmp" && mv "$hf_tmp" "$HF"
        
        if [[ "$1" == *"limit: 0"* ]]; then 
            echo -e "\033[1;33m⚠️  Quota Exceeded (Limit 0). Blocking '$M'.\033[0m" >&2
            local kh bf_tmp
            kh=$(cksum <<< "$k" | cut -d' ' -f1)
            bf_tmp=$(mktemp "$D/b.XXXXXX.json") && jq --arg k "$kh" --arg m "$M" '.[$k]+=[$m]|.[$k]|=unique' "$BF" > "$bf_tmp" && mv "$bf_tmp" "$BF"
        fi 
    }

    _display_history() {
        local hf="$1" skip_tok="${2:-0}" label="$3"
        local head_n="${4:-}" tail_n="${5:-}" head_tok="${6:-}" tail_tok="${7:-}"

        if [ ! -s "$hf" ] || [ "$(cat "$hf")" = "[]" ]; then 
            echo -e "\033[1;33m(No history for '$label')\033[0m"; return 0
        fi

        local sliced_tmp; sliced_tmp=$(mktemp "$D/slice.XXXXXX.json") || return 1

        if [ -n "$head_n" ]; then 
            jq ".[0:${head_n}]" "$hf" > "$sliced_tmp"
        elif [ -n "$tail_n" ]; then
            if [ "$tail_n" -eq 0 ]; then echo "[]" > "$sliced_tmp"
            else jq ".[-${tail_n}:]" "$hf" > "$sliced_tmp"; fi
        elif [ -n "$head_tok" ]; then
            jq --argjson ht "$head_tok" '. as $m | reduce range(length) as $i ({r:[],t:0}; ($m[$i].parts[0].text//"" | length/4|floor) as $k | if .t+$k <= $ht then {r:(.r+[$m[$i]]),t:(.t+$k)} else . end) | .r' "$hf" > "$sliced_tmp"
        elif [ -n "$tail_tok" ]; then
            jq --argjson tt "$tail_tok" '. as $m | (length-1) as $l | reduce range($l;-1;-1) as $i ({r:[],t:0}; ($m[$i].parts[0].text//"" | length/4|floor) as $k | if .t+$k <= $tt then {r:[$m[$i]]+.r,t:(.t+$k)} else . end) | .r' "$hf" > "$sliced_tmp"
        else 
            cp "$hf" "$sliced_tmp"
        fi

        local total shown shown_tok
        total=$(jq 'length' "$hf")
        shown=$(jq 'length' "$sliced_tmp")
        shown_tok=$(jq '[.[].parts[0].text//""|length]|add//0|./4|floor' "$sliced_tmp")

        echo -e "\033[1;34m─── History: $label ───\033[0m"
        if [ -n "$head_n" ] || [ -n "$tail_n" ] || [ -n "$head_tok" ] || [ -n "$tail_tok" ]; then 
            echo -e "\033[2mShowing $shown of $total messages | ~$shown_tok tokens\033[0m"
        else 
            echo -e "\033[2m$shown messages | ~$shown_tok tokens\033[0m"
        fi
        echo ""

        jq -r --argjson skip "$skip_tok" '
            to_entries[] | (.key + 1) as $i | .value.role as $role | (.value.parts[0].text // "") as $text | ($text | length / 4 | floor) as $toks |
            (if $role == "user" then "\u001b[1;36m[\($i)] You (~\($toks) tokens):\u001b[0m" else "\u001b[1;32m[\($i)] Gemini (~\($toks) tokens):\u001b[0m" end),
            (if $skip > 0 and $toks > $skip then "  \u001b[2m[skipped — ~\($toks) tokens (exceeds skip-over limit)]\u001b[0m" else $text end), ""' "$sliced_tmp" 2>/dev/null
        rm -f "$sliced_tmp"
    }

    _chat_submenu() {
        local tgt="$1" c_head="" c_tail="" c_ht="" c_tt="" c_skip="0" b_id="" c_sel=""
        local src_hf="$D/h_${tgt}.json"
        
        [ -f "$src_hf" ] && jq -e . "$src_hf" >/dev/null 2>&1 || echo "[]" > "$src_hf"
        
        while true; do
            echo -e "\n\033[1;34m--- Chat Menu: $tgt ---\033[0m" >&2
            echo -e "1) \033[1;32mSet as Default & Use\033[0m" >&2
            echo -e "2) \033[1;36mUse Temporarily\033[0m" >&2
            echo -e "3) \033[1;33mView History\033[0m (Applies filters below)" >&2
            echo -e "4) \033[1;35mBranch to New ID\033[0m (Forks using filters below)" >&2
            echo -e "----------------------------------------" >&2
            echo -e "5) Msg Head limit:     \033[1;36m[${c_head:-(All)}]\033[0m" >&2
            echo -e "6) Msg Tail limit:     \033[1;36m[${c_tail:-(All)}]\033[0m" >&2
            echo -e "7) Token Head limit:   \033[1;36m[${c_ht:-(All)}]\033[0m" >&2
            echo -e "8) Token Tail limit:   \033[1;36m[${c_tt:-(All)}]\033[0m" >&2
            echo -e "9) Skip-Over (Tokens): \033[1;36m[${c_skip:-0}]\033[0m (Display only)" >&2
            echo -e "r) Return to Chat List" >&2
            echo -e "0) Abort" >&2
            
            _ui_read c_sel "Select > " || return 0
            
            case "$c_sel" in
                1) return 10 ;; 
                2) return 11 ;; 
                3) 
                    _display_history "$src_hf" "$c_skip" "$tgt" "$c_head" "$c_tail" "$c_ht" "$c_tt"
                    _ui_read c_sel "(Press Enter to continue...) " ;;
                4)
                    _ui_read b_id "Enter New Branch ID: "
                    b_id=$(sed 's/[^a-zA-Z0-9_-]//g' <<< "$b_id")
                    if [ -z "$b_id" ]; then echo "Invalid ID." >&2; continue; fi
                    
                    local dst_hf="$D/h_${b_id}.json" dst_sf="$D/s_${b_id}.txt" src_sf="$D/s_${tgt}.txt"
                    
                    if [ -f "$dst_hf" ]; then
                        _ui_read c_sel "Session '$b_id' exists. Overwrite? (y/N): "
                        [[ ! "$c_sel" =~ ^[Yy] ]] && continue
                    fi
                    
                    local sliced_tmp; sliced_tmp=$(mktemp "$D/slice.XXXXXX.json")
                    
                    if [ -n "$c_head" ]; then 
                        jq ".[0:${c_head}]" "$src_hf" > "$sliced_tmp"
                    elif [ -n "$c_tail" ]; then
                        if [ "$c_tail" -eq 0 ]; then echo "[]" > "$sliced_tmp"
                        else jq ".[-${c_tail}:]" "$src_hf" > "$sliced_tmp"; fi
                    elif [ -n "$c_ht" ]; then
                        jq --argjson ht "$c_ht" '. as $m | reduce range(length) as $i ({r:[],t:0}; ($m[$i].parts[0].text//"" | length/4|floor) as $k | if .t+$k <= $ht then {r:(.r+[$m[$i]]),t:(.t+$k)} else . end) | .r' "$src_hf" > "$sliced_tmp"
                    elif [ -n "$c_tt" ]; then
                        jq --argjson tt "$c_tt" '. as $m | (length-1) as $l | reduce range($l;-1;-1) as $i ({r:[],t:0}; ($m[$i].parts[0].text//"" | length/4|floor) as $k | if .t+$k <= $tt then {r:[$m[$i]]+.r,t:(.t+$k)} else . end) | .r' "$src_hf" > "$sliced_tmp"
                    else 
                        cp "$src_hf" "$sliced_tmp"
                    fi
                    
                    mv "$sliced_tmp" "$dst_hf"
                    [ -s "$src_sf" ] && cp "$src_sf" "$dst_sf" || touch "$dst_sf"
                    
                    echo -e "\033[1;32m✅ Branched to '$b_id'.\033[0m" >&2
                    chat_id="$b_id"; return 2 ;;
                5) _ui_read c_head "Msg Head (empty for All): "; c_head=$(grep -o '^[0-9]*' <<< "$c_head"); c_tail=""; c_ht=""; c_tt="" ;;
                6) _ui_read c_tail "Msg Tail (empty for All): "; c_tail=$(grep -o '^[0-9]*' <<< "$c_tail"); c_head=""; c_ht=""; c_tt="" ;;
                7) _ui_read c_ht "Token Head (empty for All): "; c_ht=$(grep -o '^[0-9]*' <<< "$c_ht"); c_head=""; c_tail=""; c_tt="" ;;
                8) _ui_read c_tt "Token Tail (empty for All): "; c_tt=$(grep -o '^[0-9]*' <<< "$c_tt"); c_head=""; c_tail=""; c_ht="" ;;
                9) _ui_read c_skip "Skip-Over Tokens (0 to disable): "; c_skip=$(grep -o '^[0-9]*' <<< "$c_skip") ;;
                [rR]) return 12 ;;
                0) return 0 ;;
            esac
        done
    }

    local BF="$D/b.json" STF="$D/stream.txt" IDF="$D/id.txt" KF="$D/k.txt" AF="$D/a.txt" MF="$D/m.txt" CF="$D/c.txt" WF="$D/w.json"
    
    jq -e . "$BF" >/dev/null 2>&1 || echo "{}" > "$BF"
    jq -e . "$WF" >/dev/null 2>&1 || echo "{}" > "$WF"
    [[ "$(<"$STF" 2>/dev/null)" != "1" ]] && echo "0" > "$STF"
    [[ "$(<"$CF"  2>/dev/null)" != "1" ]] && echo "0" > "$CF"

    local chat_id="default"; local ci=$(sed 's/[^a-zA-Z0-9_-]//g' "$IDF" 2>/dev/null)
    [ -n "$ci" ] && chat_id="$ci" || echo "default" > "$IDF"

    local M="gemini-flash-latest"; [ -s "$MF" ] && M=$(<"$MF")

    local k="" n=0 s="" mo=0 show_all=0 stream_mode=0 select_id=0 del_mode=0 manage_key=0
    local arg_id="" arg_m="" arg_k="" p=""
    local interactive=1; local has_pipe=0; [ ! -t 0 ] && has_pipe=1
    local continuous=0; [ "$(<"$CF" 2>/dev/null)" == "1" ] && continuous=1

    if [ "$#" -eq 0 ] && [ "$has_pipe" -eq 0 ]; then
        echo -e "\033[1;33mUsage:\033[0m askai [flags] <prompt>" >&2
        echo -e "\033[1;36mContext:\033[0m ID=[$chat_id] | Model=[$M]" >&2
        echo -e "\033[1;37mSession Flags:\033[0m
  -id [chat_name]    Select Chat, View History, or Branch (Menu)
  -n                 New Chat Menu (Clear/Rename)
  -d                 Delete History Menu" >&2
        echo -e "\033[1;37mConfig Flags:\033[0m
  -m [model_name]    Select/Edit Model (empty to list)
  -k [api_key]       Set/Manage API Key
  -s [sys_prompt]    Set System Prompt
  -c, --continuous   Toggle/Set Continuous Mode
  --stream           Toggle/Set Streaming Output
  --persistence      Move/Edit Data Storage Location" >&2
        echo -e "\033[1;37mAdvanced / Automation:\033[0m
  -pipe smart        Automate UI via stdin lines, remainder is prompt
  -pipe hard         Disable interactive menus entirely
  -id|name|val|val   Pipe automation via arguments (Macro string)
  -h, --help         Show this help" >&2
        return 0
    fi

    while [[ "$#" -gt 0 ]]; do 
        local arg="$1"
        case "$arg" in
        -h|--help) askai; return 0;;
        --persistence) 
            require_interaction "Persistence Menu" || return 1
            echo -e "\033[1;34m--- Persistence Settings ---\033[0m\nCurrent: $D" >&2
            local np; _ui_read np "New path (e.g. ~/Documents/askai or /sdcard/askai): " || return 1
            [ -z "$np" ] && { echo "Aborted." >&2; return 0; }
            np="${np/#\~/$HOME}"
            if mkdir -p "$CONF_DIR" "$np" 2>/dev/null && chmod 700 "$np" 2>/dev/null && touch "$np/.test" 2>/dev/null; then
                rm -f "$np/.test"; echo "Copying data..." >&2; cp -r "$D/"* "$np/" 2>/dev/null
                echo "$np" > "$PATH_FILE"; D="$np"; echo -e "\033[1;32mData migrated to $D\033[0m" >&2; return 0
            else 
                echo -e "\033[1;31mError: Path '$np' invalid or not writable.\033[0m" >&2; return 1
            fi;;
        -c|--continuous) 
            if [[ "$#" -eq 1 && -z "$p" ]]; then
                require_interaction "Continuous Settings" || return 1
                echo -e "\033[1;34m--- Continuous Settings ---\033[0m\n1) Enable Always (Default)\n2) Enable Once (This session)\n3) Disable Default\n0) Abort" >&2
                local c; _ui_read c "Choice > " || return 1
                case "$c" in 1) echo "1" > "$CF"; return 0;; 2) continuous=1; return 0;; 3) echo "0" > "$CF"; return 0;; *) return 0;; esac
            else 
                continuous=1; shift
            fi;;
        --stream) 
            if [[ "$#" -eq 1 && -z "$p" ]]; then 
                require_interaction "Stream Settings" || return 1
                echo -e "\033[1;34m--- Stream Settings ---\033[0m\n1) Enable Always\n2) Enable Once (Next msg)\n0) Abort" >&2
                local c; _ui_read c "Choice > " || return 1
                [ "$c" = "1" ] && echo "1" > "$STF"; [ "$c" = "2" ] && stream_mode=1; return 0
            else 
                stream_mode=1; shift
            fi;;
        -pipe) 
            if [[ "$2" == "hard" ]]; then 
                interactive=0; shift 2; 
            elif [[ "$2" == "smart" ]]; then 
                pipe_smart=1; interactive=1; shift 2;
            else 
                echo "Error: -pipe requires 'hard' or 'smart'" >&2; return 1
            fi;;
        -k|--key) 
            if [[ -n "$2" && ! "$2" =~ ^- ]]; then arg_k="$2"; shift 2; else manage_key=1; shift; fi;;
        -id|--id) 
            if [[ -n "$2" && ! "$2" =~ ^- ]]; then 
                if [[ "$2" == *"|"* ]]; then 
                    arg_id="${2%%|*}"
                    set -f; IFS='|' read -r -a new_macros <<< "${2#*|}"; set +f
                    MACRO_Q+=("${new_macros[@]}")
                else 
                    arg_id="$2"
                fi
                shift 2
            else 
                select_id=1; shift
            fi;;
        -id\|*|--id\|*)
            local full_val="${arg#*|}"
            arg_id="${full_val%%|*}"
            local m="${full_val#*|}"
            if [[ "$m" != "$full_val" ]]; then
                set -f; IFS='|' read -r -a new_macros <<< "$m"; set +f
                MACRO_Q+=("${new_macros[@]}")
            fi
            shift;;
        -n) n=1; shift;; 
        -d|--delete) del_mode=1; shift;;
        -s) if [[ -n "$2" ]]; then s="$2"; shift 2; else echo "Error: -s missing arg" >&2; return 1; fi;;
        -m) mo=1; if [[ -n "$2" && ! "$2" =~ ^- ]]; then arg_m="$2"; shift 2; else shift; fi;;
        -1) show_all=1; shift;; 
        *) p="${p:+$p }$1"; shift;;
        esac
    done

    if [ "$manage_key" -eq 1 ]; then 
        require_interaction "Key Manager" || return 1
        local ck="None"; [ -s "$KF" ] && { local rk=$(<"$KF"); ck="...${rk: -4}"; }
        local ca="Off"; [ "$(<"$AF" 2>/dev/null)" = "1" ] && ca="On"
        echo -e "\033[1;33m--- Key Manager ---\033[0m\nStored Key: $ck\nAuto-Use:   $ca\n1) Update/Set Key (Permanent)\n2) Toggle Auto-Use\n3) Use Key Once (Temp)\n0) Abort" >&2
        local kc; _ui_read kc "Choice > " || return 1
        case "$kc" in 
            1) local nk; _ui_read -s nk "Enter New Key: " || return 1; echo "$nk" > "$KF"; echo 1 > "$AF"; echo "Key saved." >&2; return 0;; 
            2) if [ "$ca" == "On" ]; then echo 0 > "$AF"; echo "Auto-Use OFF" >&2; else echo 1 > "$AF"; echo "Auto-Use ON" >&2; fi; return 0;; 
            3) _ui_read -s arg_k "Enter Temp Key: " || return 1;; 
            *) return 0;; 
        esac
    fi

    if [ "$del_mode" -eq 1 ]; then 
        require_interaction "Delete Menu" || return 1
        echo -e "\033[1;31m--- Delete Menu ---\033[0m\n1) Delete ALL histories\n2) Delete Current ID [$chat_id]\n0) Abort" >&2
        local dc; _ui_read dc "Choice > " || return 1
        case "$dc" in 
            1) rm -f "$D"/h_*.json; echo "All histories deleted." >&2; return 0;; 
            2) rm -f "$D/h_${chat_id}.json"; echo "Deleted $chat_id." >&2; chat_id="default"; echo "default" > "$IDF"; return 0;; 
            *) return 0;; 
        esac
    fi

    if [ "$n" -eq 1 ]; then 
        require_interaction "New Chat Menu" || return 1
        while true; do 
            local nid; _ui_read nid "Enter Chat ID for New Session: " || return 1
            local clean_nid=$(sed 's/[^a-zA-Z0-9_-]//g' <<< "$nid")
            [ -z "$clean_nid" ] && continue
            if [ -f "$D/h_${clean_nid}.json" ]; then 
                echo -e "\033[1;33mID '$clean_nid' exists.\033[0m\n1) Overwrite\n2) New Name\n3) Rename Old\n0) Abort" >&2
                local nc; _ui_read nc "> " || return 1
                case "$nc" in 
                    1) chat_id="$clean_nid"; rm -f "$D/h_${chat_id}.json"; echo "$chat_id" > "$IDF"; break;; 
                    2) continue;; 
                    3) local old_name; _ui_read old_name "Rename old to: " || return 1; mv "$D/h_${clean_nid}.json" "$D/h_${old_name}.json"; chat_id="$clean_nid"; echo "$chat_id" > "$IDF"; break;; 
                    *) return 0;; 
                esac
            else 
                chat_id="$clean_nid"; echo "$chat_id" > "$IDF"; break
            fi
        done
    fi

    if [ -n "$arg_id" ]; then 
        if [ -z "$p" ] && [ "$has_pipe" -eq 0 ] && [ "$pipe_smart" -eq 0 ] && [ ${#MACRO_Q[@]} -eq 0 ]; then 
            require_interaction "ID Selector" || return 1
            _chat_submenu "$arg_id"
            local ret=$?
            [ $ret -eq 10 ] && { chat_id="$arg_id"; echo "$chat_id" > "$IDF"; }
            [ $ret -eq 11 ] && chat_id="$arg_id"
            [ $ret -eq 12 ] && return 0
            [ $ret -eq 0 ] && return 0
        else 
            chat_id="$arg_id"
        fi
    fi

    if [ "$select_id" -eq 1 ]; then 
        require_interaction "Session List" || return 1
        while true; do 
            echo -e "\n\033[1;34m--- Select a Chat to Use, View History, or Branch ---\033[0m" >&2
            
            local fl=()
            while IFS= read -r f; do [ -n "$f" ] && fl+=("$f"); done < <(ls -t "$D"/h_*.json 2>/dev/null)
            
            local ids=() i=1
            if [ ${#fl[@]} -gt 0 ]; then 
                for f in "${fl[@]}"; do 
                    local nm=$(basename "$f"|sed 's/^h_//;s/\.json$//')
                    ids+=("$nm")
                    local stats=$(jq -r '(length | tostring) + " " + ([.[].parts[].text // ""] | join("") | length | tostring)' "$f" 2>/dev/null || echo "0 0")
                    local msg_n chars_n; read -r msg_n chars_n <<< "$stats"
                    local tok_n=$((chars_n / 4))
                    local cur_mark=""; [ "$nm" == "$chat_id" ] && cur_mark="\033[1;32m(*)\033[0m"
                    printf "%2d) \033[1;36m%-18s\033[0m %8d chars | %6d tokens | %4d msgs %b\n" "$i" "$nm" "$chars_n" "$tok_n" "$msg_n" "$cur_mark" >&2
                    ((i++))
                done
            else 
                echo "(No saved histories)" >&2
            fi
            
            echo -e "\n+) Create New Chat ID" >&2
            echo "0) Abort" >&2
            local sel; _ui_read sel "Select > " || return 1
            
            if [[ "$sel" == "0" ]]; then 
                return 0
            elif [[ "$sel" == "+" ]]; then 
                local nn; _ui_read nn "Enter New Name: " || return 1
                local pk=$(sed 's/[^a-zA-Z0-9_-]//g' <<< "$nn"); [ -z "$pk" ] && continue
                _chat_submenu "$pk"
                local ret=$?
                [ $ret -eq 10 ] && { chat_id="$pk"; echo "$chat_id" > "$IDF"; break; }
                [ $ret -eq 11 ] && { chat_id="$pk"; break; }
                [ $ret -eq 2 ] && break
                [ $ret -eq 0 ] && return 0
            elif [[ "$sel" =~ ^[0-9]+$ && "$sel" -le "${#ids[@]}" && "$sel" -gt 0 ]]; then 
                local pk="${ids[$((sel-1))]}"
                _chat_submenu "$pk"
                local ret=$?
                [ $ret -eq 10 ] && { chat_id="$pk"; echo "$chat_id" > "$IDF"; break; }
                [ $ret -eq 11 ] && { chat_id="$pk"; break; }
                [ $ret -eq 2 ] && break
                [ $ret -eq 0 ] && return 0
                [ $ret -eq 12 ] && continue
            fi
        done
    fi

    local HF="$D/h_${chat_id}.json"; local SF="$D/s_${chat_id}.txt"
    [ -f "$HF" ] && jq -e . "$HF" >/dev/null 2>&1 || echo "[]" > "$HF"; [ ! -f "$SF" ] && touch "$SF"

    if [ -n "$arg_k" ]; then 
        if [ -z "$p" ] && [ "$has_pipe" -eq 0 ] && [ "$pipe_smart" -eq 0 ] && [ ${#MACRO_Q[@]} -eq 0 ]; then 
            require_interaction "Key Confirm" || return 1
            echo -e "\033[1;33mProperty: API Key = '...${arg_k: -4}'\033[0m\n1) Save as Default\n2) Use Temporarily\n0) Abort" >&2
            local c; _ui_read c "Choice > " || return 1
            case "$c" in 1) k="$arg_k"; echo "$k" > "$KF"; echo 1 > "$AF";; 2) k="$arg_k";; *) return 0;; esac
        else 
            k="$arg_k"
        fi 
    fi

    if [ -z "$k" ]; then 
        if [ -s "$KF" ] && [ "$(<"$AF" 2>/dev/null)" = "1" ]; then 
            k=$(<"$KF")
        else 
            require_interaction "API Key Setup" || return 1
            _ui_read -s k "Enter Gemini API Key: " || return 1; echo "$k" > "$KF"; echo 1 > "$AF"
        fi
    fi

    if [ -n "$arg_m" ]; then 
        if [ -z "$p" ] && [ "$has_pipe" -eq 0 ] && [ "$pipe_smart" -eq 0 ] && [ ${#MACRO_Q[@]} -eq 0 ]; then 
            require_interaction "Model Confirm" || return 1
            echo -e "\033[1;33mProperty: Model = '$arg_m'\033[0m\n1) Set as Default\n2) Use Temporarily\n0) Abort" >&2
            local c; _ui_read c "Choice > " || return 1
            case "$c" in 1) M="$arg_m"; echo "$M" > "$MF";; 2) M="$arg_m";; *) return 0;; esac
        else 
            M="$arg_m"
        fi 
    fi

    if [ "$mo" -eq 1 ] && [ -z "$arg_m" ]; then 
        require_interaction "Model List" || return 1
        while true; do 
            echo -e "\033[1;30mFetching models for '$chat_id'...\033[0m" >&2
            local jm=$(curl -s --connect-timeout 10 -H "x-goog-api-key: $k" "$API")
            local api_err=$(jq -r '.error.message // empty' 2>/dev/null <<< "$jm")
            if [ -n "$api_err" ]; then echo -e "\033[1;31m❌ API Error:\033[0m $api_err" >&2; return 1; fi

            local bk=$(<"$BF"); local kh=$(cksum <<< "$k" | cut -d' ' -f1)
            local jq_sort='.models[]|select(.supportedGenerationMethods[]?|contains("generateContent"))|.name|=sub("^models/";"")|.score=0|if(.name|contains("-pro"))then .score+=1000 elif(.name|contains("-flash"))then .score+=800 elif(.name|contains("-lite"))then .score+=600 else . end|if(.name|test("gemini-[0-9]\\.[0-9]"))then .score+=((.name|capture("gemini-(?<v>[0-9]\\.[0-9])").v|tonumber)*100)else . end|if(.name|contains("-latest"))then .score+=10000 elif(.name|contains("-exp"))then .score+=-5000 elif(.name|contains("-preview"))then if(.name|test("preview-[0-9]{2}-[0-9]{2}"))then .score+=-2000 else .score+=500 end else .score+=5000 end|if(.name|test("gemma|learnlm|tts|image|robotics|computer-use|thinking"))then .score+=-50000 else . end|select($a=="1" or(.name as $n|($bk[$h]//[])|index($n)|not))|{name:.name,score:.score}'
            local ml=(); mapfile -t ml < <(jq -r --arg h "$kh" --arg a "$show_all" --argjson bk "$bk" "$jq_sort" <<< "$jm" | jq -rs 'sort_by(.score)|reverse|.[].name')
            local hc=$(jq -r --arg h "$kh" '.[$h]//[]|length' <<< "$bk"); local i=1
            
            for md in "${ml[@]}"; do
                if [ "$md" == "$M" ]; then echo -e "$i) \033[1;32m$md (*)\033[0m" >&2; else echo "$i) $md" >&2; fi; ((i++))
            done
            
            echo "-1) list 0 limit models too, currently $hc" >&2
            local sl; _ui_read sl "Select Model (1-${#ml[@]}, 0 to Abort): " || return 1
            if [ "$sl" == "-1" ]; then show_all=$((1-show_all)); continue; fi; [ "$sl" = "0" ] && return 0
            
            if [[ "$sl" =~ ^[0-9]+$ && "$sl" -le "${#ml[@]}" ]]; then 
                local sel="${ml[$((sl-1))]}"
                echo -e "\033[1;33mModel: $sel\033[0m\n1) Save as Default\n2) Use Once\n3) Cancel (Keep $M)\n4) Retry" >&2
                local sc; _ui_read sc "Choice > " || return 1
                case "$sc" in 1) M="$sel"; echo "$M" > "$MF"; break;; 2) M="$sel"; break;; 3) break;; 4) continue;; *) return 0;; esac
            fi
        done
    fi

    [ -n "$s" ] && echo "$s" > "$SF"
    
    if [ "$has_pipe" -eq 1 ] && [ -z "$p" ] && [ "$pipe_smart" -eq 0 ] && [ ${#MACRO_Q[@]} -eq 0 ]; then
        p=$(</dev/stdin)
    fi

    while true; do
        if [ -z "$p" ]; then 
            if [ ${#MACRO_Q[@]} -gt 0 ]; then
                _ui_read p "Prompt > " || return 1
            elif [ "$continuous" -eq 1 ] || { [ "$pipe_smart" -eq 1 ] && [ ! -t 0 ]; }; then 
                echo -e "\033[1;34m> (Reading prompt from stream... Ctrl+D to send)\033[0m" >&2; p=$(cat)
            else 
                _ui_read p "Prompt > " || return 1 
            fi
            [ -z "$p" ] && return 0
        fi

        local h_chars msg_n
        read -r msg_n h_chars <<< "$(jq -r '(length + 1 | tostring) + " " + ([.[].parts[].text // ""] | join("") | length | tostring)' "$HF" 2>/dev/null || echo "1 0")"

        local _est_tok=$(( (${h_chars:-0} + ${#p}) / 4 ))
        if [ "$_est_tok" -gt 200000 ]; then
            if ! jq -e --arg id "$chat_id" '.[$id]' "$WF" >/dev/null 2>&1; then
                echo -e "\033[1;33m⚠️  Session '$chat_id' has exceeded ~200k tokens.\033[0m" >&2
                echo -e "\033[2m   To trim context, type: askai -id (Select this chat -> Branch to New ID)\033[0m" >&2
                local _wf_tmp; _wf_tmp=$(mktemp "$D/w.XXXXXX.json") && \
                    jq --arg id "$chat_id" '.[$id] = true' "$WF" > "$_wf_tmp" && mv "$_wf_tmp" "$WF"
            fi
        fi

        local sys_stat=""; [ -s "$SF" ] && sys_stat=" system:loaded"
        echo -e "\033[1;30mid:$chat_id message:$msg_n timestamp:$(date -u +"%Y%m%d_%H%M%Sutc") tokens:$((${h_chars:-0}/4))+$(( ${#p}/4 )) model:$M$sys_stat\033[0m" >&2

        local hf_tmp
        if ! hf_tmp=$(mktemp "$D/h.XXXXXX.json") || ! jq --arg t "$p" '.+[{"role":"user","parts":[{"text":$t}]}]' "$HF" > "$hf_tmp"; then 
            rm -f "$hf_tmp" 2>/dev/null; echo "Error: History corrupted. Resetting..." >&2; echo "[]" > "$HF"
            hf_tmp=$(mktemp "$D/h.XXXXXX.json") && jq --arg t "$p" '.+[{"role":"user","parts":[{"text":$t}]}]' "$HF" > "$hf_tmp" || { echo "Fatal: Cannot write to history." >&2; return 1; }
        fi
        mv "$hf_tmp" "$HF"

        jq -n --slurpfile h "$HF" --arg s "$(<"$SF")" '{contents:$h[0]}+(if($s|length>0)then{system_instruction:{parts:[{text:$s}]}}else{}end)' > "$PF"

        local ft=""; local us="0"; [[ "$(<"$STF" 2>/dev/null)" == "1" ]] && us="1"; [ "$stream_mode" -eq 1 ] && us=1
        echo -e "\033[1;32m🤖 Gemini ($chat_id):\033[0m" >&2

        if [ "$us" == "1" ]; then 
            > "$RO"
            ERR_TMP=$(mktemp "$D/err.XXXXXX.tmp")
            
            curl -s -N --connect-timeout 10 --max-time 120 -X POST "$API/$M:streamGenerateContent?alt=sse" -H "x-goog-api-key: $k" -H "Content-Type: application/json" -d "@$PF" | \
            jq --unbuffered -R -j 'if startswith("data: ")then .[6:]|fromjson?|if .error.message then "\(.error.message)\n"|halt_error(1) else .candidates[0].content.parts[0].text//empty end elif startswith("{")then fromjson?|.error.message|select(.!=null)|"\(.)\n"|halt_error(1) else empty end' 2> "$ERR_TMP" | tee "$RO"
            
            echo "" >&2
            if [ -s "$ERR_TMP" ]; then handle_err "$(<"$ERR_TMP")"; rm -f "$ERR_TMP"; ERR_TMP=""; return 1; fi
            rm -f "$ERR_TMP"; ERR_TMP=""
            
            ft=$(<"$RO")
            if [ -z "$ft" ]; then echo -e "\033[1;31m❌ Network Error: No response received (timeout or connection failure).\033[0m" >&2; _rollback_last; return 1; fi
        else
            local r=$(curl -s --connect-timeout 10 --max-time 30 -X POST "$API/$M:generateContent" -H "x-goog-api-key: $k" -H "Content-Type: application/json" -d "@$PF")
            if [ -z "$r" ]; then echo -e "\033[1;31m❌ Network Error: No response received (timeout or connection failure).\033[0m" >&2; _rollback_last; return 1; fi
            local er=$(jq -r '.error.message // empty' <<< "$r")
            if [ -n "$er" ]; then handle_err "$er"; return 1; fi
            ft=$(jq -r '.candidates[0].content.parts[0].text // empty' <<< "$r"); printf "%s\n" "$ft"
            if [ -z "$ft" ]; then echo -e "\033[1;33m⚠️  Empty response from model (possible safety filter or quota issue).\033[0m" >&2; _rollback_last; return 1; fi
        fi

        if [ -n "$ft" ]; then
            local hf_tmp2
            hf_tmp2=$(mktemp "$D/h.XXXXXX.json") && jq --arg t "$ft" '.+[{"role":"model","parts":[{"text":$t}]}]' "$HF" > "$hf_tmp2" && mv "$hf_tmp2" "$HF"
        fi
        
        if [ "$continuous" -eq 0 ] && [ ${#MACRO_Q[@]} -eq 0 ]; then break; fi
        p="" 
    done
}
[[ "${BASH_SOURCE[0]}" == "${0}" ]] && askai "$@"
