-- P11 契约测试：返回一个紧凑 JSON 字符串，确认回执原样保留
local s = string.rep("A", 200)
return string.format('{"ok":1,"pad":"%s","x":-21.54,"z":-36.54}', s)
