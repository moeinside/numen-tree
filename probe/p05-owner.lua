-- P05 只读：主人状态 + 附近实体
return {
  owner = numen.status.owner(),
  entities = numen.scan.entities("all", { radius = 32 }),
}
