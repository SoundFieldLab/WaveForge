import fs from 'node:fs'
const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '')
const ids = JSON.parse(fs.readFileSync('platform-ids.json', 'utf8'))
// stamp into the three v2-entries files (source of truth for module generation)
for (const [file, mid] of [['pcs-final.json', null], ['aki-v2-entries.json', 15319615], ['byn-v2-entries.json', 1592191]]) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  let stamped = 0
  for (const e of entries) {
    const key = `${norm(e.songName)}|${norm((e.artists || e.songArtists || [])[0] || '')}`
    const hit = ids[key]
    if (hit) {
      e.platformIds = hit
      if (mid) e.uploaderMid = mid
      stamped++
    }
  }
  fs.writeFileSync(file, JSON.stringify(entries, null, 1))
  console.log(`${file}: stamped ${stamped}/${entries.length}`)
}
