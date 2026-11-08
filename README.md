# Numen 鑴戞爲锛坣umen-tree锛?
缁?Minecraft 閲岀殑 Numen 鍚屼即鍔犱竴灞?*甯搁┗鐨勮嚜鍔ㄦ墽琛屽眰**锛岃 LLM 浠?閫愭寰搷"閫€鍥?鍙笅鐩爣"銆?
> 涓€鍙ヨ瘽锛?*LLM 褰撴寚鎸ュ畼锛屾爲褰撳皬鑴戯紝numen 鐨勮韩浣撳拰鍙嶅皠鐓ф棫銆?*

**鎺ユ墜璇峰厛璇?馃憠 [docs/09-浜ゆ帴-2026-11-07.md](docs/09-浜ゆ帴-2026-11-07.md)**锛堢幇鐘躲€佷笅涓€姝ャ€佸潙锛?
---

## 1. 涓€鍙ヨ瘽鐜扮姸

鏍戣繘绋嬭兘璺戯細涓嬬洰鏍?鈫?鎵ц 鈫?涓婃姤锛汳1 璧锋敮鎸?*鎰忓浘 鈫?璁″垝 鈫?鍒嗘鎵ц 鈫?闃舵涓婃姤**锛堥厤鏂硅〃 + 涓柇琛?+ 鎭㈠琛紝鍔犺涓哄彧鍔犳暟鎹級銆?鏀寔 **survival / production / combat** 涓夌妯″紡锛堟寜鍚屼即鐙珛鍒囨崲锛夊拰**澶氬悓浼村苟鍙?*锛汱LM 閫氳繃 10 涓?MCP 宸ュ叿鎸囨尌锛堝惈鍦扮偣绨?`tree_place`銆佽鍒掍换鍔?`tree_task`锛夛紝涓嶇洿鎺ュ啓 Lua銆?
---

## 2. 浜斿垎閽熶笂鎵?
鍓嶇疆锛氭父鎴忓凡鍚姩锛坣umen MCP 鍦?`127.0.0.1:8765`锛夛紝鑷冲皯涓€涓悓浼村湪绾裤€?
```powershell
cd E:\game\HMCL\numen-tree

# 1) 璧锋爲锛堝弻鍑?鍚姩鏍戣繘绋?bat 涔熷彲浠ワ級
node src/daemon.mjs

# 2) 鐪嬬姸鎬?node src/cli.mjs status          # 鍚屼即鍦ㄥ摢/鍦ㄥ共浠€涔?褰撳墠鎶€鑳藉凡杩愯绉掓暟/涓婁竴姝?node src/cli.mjs skills          # 16 涓妧鑳藉崱
node src/cli.mjs lines           # 鍙拌瘝搴?node src/cli.mjs inbox --brain   # 鈽?闇€瑕佸ぇ鑴戝喅绛栫殑涓婃姤

# 3) 涓嬬洰鏍?node src/cli.mjs goal --companion tyrander --skill go_to --params-file probe\params-arrive.json

# 4) 鍒囨ā寮?/ 鏆傚仠 / 娓呴槦鍒?node src/cli.mjs control --companion tyrander --op mode --mode production
node src/cli.mjs control --companion tyrander --op pause
node src/cli.mjs control --companion tyrander --op clear

# 5) 鍦扮偣绨匡紙姝讳骸鐐硅嚜鍔ㄨ锛涘/鍩哄湴/鐭挎礊鎵嬪姩璁帮級
node src/cli.mjs place list
node src/cli.mjs place record --name 瀹?--pos here --note 涓讳汉鑴氫笅鐨勫熀鍦?node src/cli.mjs place find --query "涓婃姝荤殑鍦版柟"

# 6) 璁″垝浠诲姟锛圡1锛氭ā绯婃剰鍥?鈫?閰嶆柟 鈫?鍒嗘鎵ц锛?node src/cli.mjs task --companion tyrander --intent "鎶婃湪澶村瓨浜?
node src/cli.mjs task --companion tyrander --intent "鍥炲杩囧" --deadline 300
node src/cli.mjs status          # 浼氭樉绀?璁″垝 X 绗?N/鍏?M 姝ワ紙褰撳墠姝?Y锛?

# 7) 绂荤嚎鍥炴斁娴嬭瘯锛堜笉寮€娓告垙锛?node probe/replay.mjs

# 8) 鏀瑰畬鎶€鑳藉崱鐑噸杞?/ 浼橀泤閫€鍑猴紙涓嶈 taskkill锛屼細鐣欏兊灏搁攣锛?node src/cli.mjs control --op reload-skills
node src/cli.mjs control --op exit
```

| 绔彛 | 鐢ㄩ€?|
|---|---|
| 8765 | numen 鐨?MCP锛堟父鎴忓唴锛?|
| 8766 | 鏍戠殑鎺у埗 API锛圕LI 鐢級 |
| 8767 | 鏍戝 LLM 鐨?MCP 宸ュ叿闈?|

---

## 3. 鐩綍

```
numen-tree/
鈹溾攢 README.md                  鈫?鏈枃浠?鈹溾攢 鍚姩鏍戣繘绋?bat             鍙屽嚮璧锋爲锛堣嚜鍔ㄥ鐞嗙鍙ｅ啿绐侊級
鈹溾攢 tree.config.json           鎵€鏈夊彲璋冨弬鏁?鈹溾攢 docs/
鈹? 鈹溾攢 01-闇€姹備笌鏋舵瀯.md         鍒嗗眰銆佹暟鎹祦銆佹墽琛屾ā鍨嬨€佺壍寮曠怀銆佷笁妯″紡
鈹? 鈹溾攢 02-鎺㈤拡璁板綍.md           mod 鍐呴儴缁撴瀯銆佸疄娴嬫暟鎹€佸兊灏搁攣鍒嗘瀽
鈹? 鈹溾攢 03-缁存姢鎵嬪唽.md           鐜銆佸惎鍋溿€佹晠闅滃缃€佸彉鏇磋褰?鈹? 鈹溾攢 04-鍙墿灞曟€ц璁?md       鎶€鑳藉崱 / Lua 妯″潡 / NumenPlugin 涓夊眰鎵╁睍鐐?鈹? 鈹溾攢 05-鎺ュ彛濂戠害.md           9 涓?MCP 宸ュ叿銆佷笂鎶ユ牸寮忋€佹妧鑳藉绾︺€佸湴鐐圭翱
鈹? 鈹溾攢 06-璺嚎鍥?md             闃舵涓庣姸鎬?鈹? 鈹溾攢 07-DSH閰嶇疆鍙樻洿璁板綍.md    鎵€鏈夐」鐩鏀瑰姩 + 鍥炴粴鏂瑰紡
鈹? 鈹溾攢 08-璇曢獙璁板綍-涓夋ā寮忎笌澶氬悓浼?md
鈹? 鈹溾攢 09-浜ゆ帴-2026-11-07.md    鈽?浜ゆ帴蹇収
鈹? 鈹溾攢 10-numen-Lua-API閫熸煡.md  鈽?Lua API 鍏ㄧ鍚?+ 瀹炴祴鍧?鈹? 鈹溾攢 11-琛屼负鏍戞墦纾ㄨ褰?2026-11-07鏅?md  鈽?瑙勫垯琛?瑙呴/鎴樻枟/鍦扮偣绨?韪╁潙
鈹? 鈹溾攢 12-鍏ㄥ姛鑳芥爲璁捐-M1.md    鈽?璁″垝灞?閰嶆柟/涓柇/鎭㈠琛?+ 楠屾敹
鈹? 鈹溾攢 13-Windows-PowerShell韪╁潙鎬昏〃.md  鈽?鏈満 PowerShell 鍧戦€熸煡
鈹? 鈹斺攢 14-浜ゆ帴-2026-11-08.md    鈽呪槄 鏂颁細璇濆厛璇昏繖浠?鈹溾攢 places.json                鍦扮偣绨匡紙姝讳骸鐐?鍩哄湴/鑷畾涔夊湴鐐癸紝杩愯鏃剁敓鎴愶級
鈹溾攢 src/
鈹? 鈹溾攢 daemon.mjs              缂栨帓 + 鎺у埗 API锛堝惈 /places锛? 鍔ㄦ€佸彂鐜板悓浼?鈹? 鈹溾攢 lane.mjs                姣忓悓浼翠竴鏉℃墽琛岄€氶亾锛堣娴?浠茶/鎵ц/浜嬩欢锛?鈹? 鈹溾攢 numen.mjs               numen MCP 瀹㈡埛绔?+ 鍥炴墽瑙ｆ瀽
鈹? 鈹溾攢 state.mjs               榛戞澘 / 鐩爣鏍?/ 鏀朵欢绠?鈹? 鈹溾攢 places.mjs              鍦扮偣绨匡細鎸佷箙鍖?+ 妯＄硦瑙ｆ瀽
鈹? 鈹溾攢 lines.mjs               鍙拌瘝搴擄紙绾暟鎹?鏈烘閫夋嫨锛?鈹? 鈹溾攢 mcpserver.mjs           瀵?LLM 鐨?9 涓伐鍏?鈹? 鈹溾攢 trace.mjs               jsonl 鐣欑棔
鈹? 鈹斺攢 skills/                 16 涓妧鑳藉崱锛堣嚜鍔ㄥ彂鐜帮紝鍔犳枃浠跺嵆鎵╁睍锛?鈹溾攢 lines/                     鍙拌瘝搴撴暟鎹紙default.json + 浜鸿瑕嗙洊锛?鈹溾攢 patcher/                   鍍靛案閿佽ˉ涓?mod锛坣umenlockfix锛?鈹溾攢 probe/                     鎺㈤拡鑴氭湰锛堝彧璇讳负涓伙級
鈹斺攢 logs/                      trace-YYYYMMDD.jsonl
```

---

## 4. 鍚嶈瘝琛?
| 璇?| 鍚箟 |
|---|---|
| **澶ц剳** | 甯搁┗鐨?LLM 浼氳瘽锛圖SH锛夈€傚畾鐩爣銆佽璇濄€佸鐞嗗紓甯?|
| **鍙宠剳** | 涓€娆℃€у瓙 agent銆傛棤鐘舵€併€佺函鎺ㄧ悊銆佸彧杩斿洖鏁版嵁锛堝皻鏈疄鐜帮級 |
| **鏍?/ 灏忚剳** | 甯搁┗澶栭儴杩涚▼銆傛煡琛ㄦ墽琛屻€佷徊瑁併€佺洰鏍囨爤銆佸摠鍏点€乼race |
| **鑴婇珦** | mod 鍐呯疆鍙嶅皠锛堥€冭窇銆佽劚鍥般€佽惤鍦扮紦鍐诧級锛屼笉缁忔爲 |
| **鍚屼即** | Numen 鐨?NPC 瀹炰綋锛屽悇鑷湁鐙珛 Lua 鎵ц妲?|
| **鎶€鑳藉崱** | 鏍戦噷涓€涓彲鎵ц鎶€鑳斤細`can_start` / 鎵ц / 澶辫触鐮?|
| **瀹忚鍒?* | 鍑犱釜鎶€鑳藉崱鐨勫浐鍖栫粍鍚堬紙灏氭湭瀹炵幇锛?|
| **妯″紡** | survival / production / combat锛屾寜鍚屼即鐙珛 |
| **鐗靛紩缁?* | 绂讳富浜哄お杩滆嚜鍔ㄥ線鍥炶蛋 |
| **鍙拌瘝搴?* | 鏈烘鎾姤鐢ㄧ殑鏁版嵁琛紝杩愯鏃跺彧鏌ヨ〃涓嶇敓鎴?|
| **鍞ら啋婧?* | 鍏佽鎶?LLM 鍙啋鐨勫皝闂簨浠舵竻鍗?|

---

## 5. 涓夋潯纭竟鐣?
| 杈圭晫 | 璇存槑 |
|---|---|
| **涓嶅姩 numen 鏈綋** | 涓嶅弽缂栬瘧銆佷笉鏀瑰畠鐨勬枃浠躲€傚敮涓€渚嬪锛氬兊灏搁攣琛ヤ竵 mod锛堢嫭绔?jar锛屽垹鎺夊嵆鍥炴粴锛?|
| **涓€涓悓浼村悓涓€鏃堕棿鍙涓€涓┍鍔ㄨ€?* | 鍗?Lua 绋嬪簭妲斤紝鍙屽紑浼氫簰鐩搁攣姝?|
| **鏍戜笉鍋氬垽鏂?* | 鏌ヨ〃 + 鍥哄畾瑙勫垯锛涜瑷€鍙煡琛ㄤ笉鐢熸垚锛涘璇濆綊 LLM |

---

## 6. 璁捐鍘熷垯锛堟憳瑕侊紝鍏ㄦ枃瑙?docs/01锛?
1. 鏍戞槸"鑷姩"涓嶆槸"鑷富"銆?2. LLM 鍙湁鐩爣鏉?鍚﹀喅鏉?鏃堕棿鏉冿紝娌℃湁閫愭鎸囨尌鏉冦€?3. 鏍戞帉鎻¤妭鎷嶏紝姘镐笉绛?LLM銆?4. 涓嬭鍐欑洰鏍囥€佷笂琛岃浜嬩欢锛屼袱鏉″崟鍚戦€氶亾銆?5. 姹囨姤 = 鍒嗙被 + 浜嬪疄锛屼笉缁欏缓璁€?6. 鎶ヤ簡 = 宸插仠鎵嬬瓑浣狅紱鍙湁姹傚姪鎺紝鍏朵綑鎷夈€?7. 璐电殑鎬濊€冨鍖呯粰鍙宠剳锛岀粨鏋滄矇娣€鎴愬畯璁″垝锛堝緟鍋氾級銆?