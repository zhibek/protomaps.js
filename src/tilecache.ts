import Point from '@mapbox/point-geometry'
import { VectorTile } from '@mapbox/vector-tile'
import Protobuf from 'pbf'
import { PMTiles } from 'pmtiles'

export enum GeomType {
   Point = 1,
   Line = 2,
   Polygon = 3
}

export interface Feature {
    readonly properties: any
    readonly bbox: number[]
    readonly geomType: GeomType
    readonly geom: Point[][]
    readonly numVertices:number
}

export interface Zxy {
  readonly z: number
  readonly x: number
  readonly y: number
}

export function toIndex(c: Zxy):string {
    return c.x + ":" + c.y + ":" + c.z
}

export interface TileSource {
    get(c:Zxy,tileSize:number) : Promise<Map<string,Feature[]>>
}

// reimplement loadGeometry with a scalefactor
// so the general tile rendering case does not need rescaling.
const loadGeomAndBbox = (pbf,geometry,scale:number) => {
    pbf.pos = geometry
    var end = pbf.readVarint() + pbf.pos,
        cmd = 1,
        length = 0,
        x = 0,
        y = 0,
        lines = [],
        line,
        x1 = Infinity,
        x2 = -Infinity,
        y1 = Infinity,
        y2 = -Infinity;
    while (pbf.pos < end) {
        if (length <= 0) {
            var cmdLen = pbf.readVarint()
            cmd = cmdLen & 0x7
            length = cmdLen >> 3
        }
        length--
        if (cmd === 1 || cmd === 2) {
            x += pbf.readSVarint() * scale
            y += pbf.readSVarint() * scale
            if (x < x1) x1 = x
            if (x > x2) x2 = x
            if (y < y1) y1 = y
            if (y > y2) y2 = y
            if (cmd === 1) {
                if (line) lines.push(line);
                line = []
            }
            line.push(new Point(x, y))
        } else if (cmd === 7) {
            if (line) line.push(line[0].clone())
        } else throw new Error('unknown command ' + cmd)
    }
    if (line) lines.push(line)
    return {geom:lines, bbox: [x1, y1, x2, y2]}
}

function parseTile(buffer:ArrayBuffer,tileSize:number):Map<string,Feature[]> {
    let v = new VectorTile(new Protobuf(buffer))
    let result = new Map<string,Feature[]>()
    for (let [key,value] of Object.entries(v.layers)) {
        let features = []
        let layer = value as any
        for (let i = 0; i < layer.length; i++) {
            let feat = layer.feature(i)
            let result = loadGeomAndBbox(feat._pbf,feat._geometry,tileSize/layer.extent)
            let numVertices = 0
            for (let part of result.geom) numVertices+=part.length
            features.push({
                geomType:layer.feature(i).type,
                geom:result.geom,
                numVertices:numVertices,
                bbox:result.bbox,
                properties:layer.feature(i).properties
            })
        }
        result.set(key,features)
    }
    return result
}

export class PmtilesSource implements TileSource {
    p: PMTiles
    controllers: any[]

    constructor(url:any) {
        if (url.url) {
            this.p = url
        } else {
            this.p = new PMTiles(url)
        }
        this.controllers = []
    }

    public async get(c:Zxy,tileSize:number):Promise<Map<string,Feature[]>> {
        this.controllers = this.controllers.filter(cont => {
            if (cont[0] != c.z) {
                cont[1].abort()
                return false
            }
            return true
        })
        let result = await this.p.getZxy(c.z,c.x,c.y)
        if (!result) throw new Error(`Tile ${c.z} ${c.x} ${c.y} not found in archive`)
        const controller = new AbortController()
        this.controllers.push([c.z,controller])
        const signal = controller.signal
        return new Promise((resolve,reject) => {
            fetch(this.p.url,{headers:{Range:"bytes=" + result[0] + "-" + (result[0]+result[1]-1)},signal:signal}).then(resp => {
               return resp.arrayBuffer()
            }).then(buffer => {
                let result = parseTile(buffer,tileSize)
                resolve(result)
            }).catch( e => {
                reject(e)
            })
        })
    } 
}

export class ZxySource implements TileSource {
    url: string
    controllers: any[]

    constructor(url:string) {
        this.url = url
        this.controllers = []
    }

    public async get(c: Zxy,tileSize:number):Promise<Map<string,Feature[]>> {
        this.controllers = this.controllers.filter(cont => {
            if (cont[0] != c.z) {
                cont[1].abort()
                return false
            }
            return true
        })
        let url = this.url.replace("{z}",c.z.toString()).replace("{x}",c.x.toString()).replace("{y}",c.y.toString())
        const controller = new AbortController()
        this.controllers.push([c.z,controller])
        const signal = controller.signal
        return new Promise((resolve,reject) => {
            fetch(url,{signal:signal}).then(resp => {
                return resp.arrayBuffer()
            }).then(buffer => {
                let result = parseTile(buffer,tileSize)
                resolve(result)
            }).catch(e => {
                reject(e)
            })
        })
    } 
}

export interface CacheEntry {
    used: number
    data: Map<string,Feature[]>
}

let R = 6378137
let MAX_LATITUDE = 85.0511287798
let MAXCOORD = R * Math.PI

let project = latlng => {
    let d = Math.PI / 180
    let constrained_lat = Math.max(Math.min(MAX_LATITUDE, latlng[0]), -MAX_LATITUDE)
    let sin = Math.sin(constrained_lat * d)
    return new Point(R*latlng[1]*d,R*Math.log((1+sin)/(1-sin))/2)
}


export class TileCache {
    source: TileSource
    cache: Map<string,CacheEntry>
    inflight: Map<string,any[]>
    tileSize: number

    constructor(source: TileSource, tileSize: number) {
        this.source = source
        this.cache = new Map<string,CacheEntry>()
        this.inflight = new Map<string,any[]>()
        this.tileSize = tileSize
    }

    public queryFeatures(lng:number,lat:number,zoom:number):Feature[] {
        let projected = project([lat,lng])
        let normalized = new Point((projected.x+MAXCOORD)/(MAXCOORD*2),1-(projected.y+MAXCOORD)/(MAXCOORD*2))
        let on_zoom = normalized.mult(1 << zoom)
        let tile_x = Math.floor(on_zoom.x)
        let tile_y = Math.floor(on_zoom.y)
        const idx = toIndex({z:zoom,x:tile_x,y:tile_y})
        let retval = []
        if (this.cache.has(idx)) {
            const center_bbox_x = (on_zoom.x - tile_x) * this.tileSize
            const center_bbox_y = (on_zoom.y - tile_y) * this.tileSize
            let entry = this.cache.get(idx)
            let query_bbox = [center_bbox_x-8,center_bbox_y-8,center_bbox_x+8,center_bbox_y+8]
            for (let [layer_name,layer_arr] of (entry.data).entries()) {
                for (let feature of layer_arr) {
                    if ((query_bbox[2] >= feature.bbox[0] && feature.bbox[2] >= query_bbox[0]) &&
                        (query_bbox[3] >= feature.bbox[3] && feature.bbox[3] >= query_bbox[1])) {
                        retval.push(feature)
                    }
                }
            }
        }
        return retval
    }

    public async get(c:Zxy):Promise<Map<string,Feature[]>> {
        const idx = toIndex(c)
        return new Promise((resolve, reject) => { 
            if (this.cache.has(idx)) {
                let entry = this.cache.get(idx)
                entry.used = performance.now()
                resolve(entry.data)
            } else if (this.inflight.has(idx)) {
                this.inflight.get(idx).push([resolve,reject])
            } else {
                this.inflight.set(idx,[])
                this.source.get(c,this.tileSize).then(tile => {
                    this.cache.set(idx,{used:performance.now(),data:tile})
                    this.inflight.get(idx).forEach(f => f[0](tile))
                    this.inflight.delete(idx)
                    resolve(tile)

                    if (this.cache.size >= 64) {
                        let min_used = +Infinity
                        let min_key = undefined
                        this.cache.forEach((value,key) => {
                            if (value.used < min_used) min_key = key
                        })
                        this.cache.delete(min_key)
                    }
                }).catch(e => {
                    this.inflight.get(idx).forEach(f => f[1](e))
                    this.inflight.delete(idx)
                    reject(e)
                })
            }
        })
    }
}
