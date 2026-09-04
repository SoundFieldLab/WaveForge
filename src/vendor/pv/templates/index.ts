// PV Tool — Copyright (c) 2026 DanteAlighieri13210914
// Licensed under Non-Commercial License. See LICENSE for terms.

import type { TemplateConfig } from '../core/types';
import { blueBoldTemplate } from './blueBold';
import { kineticSplitTemplate } from './kineticSplit';
import { bluePlaneTemplate } from './bluePlane';
import { rainCityTemplate } from './rainCity';
import { geometricTemplate } from './geometric';
import { cyberpunkHudTemplate } from './cyberpunkHud';
import { emotionCinemaTemplate } from './emotionCinema';
import { hystericNightTemplate } from './hystericNight';
import { cyberGrungeTemplate } from './cyberGrunge';
import { spiderWebTemplate } from './spiderWeb';
import { staggeredTextTplTemplate } from './staggeredTextTpl';
import { calmVillainTemplate } from './calmVillain';
import { girlyCloudTemplate } from './girlyClouds';
import { sweetPinkTemplate } from './sweetPink';
import { flyMeToTheMoonTemplate } from './flyMeToTheMoon';
import { kawaiPixelTemplate } from './kawaiPixel';
import { crimeSceneTemplate } from './crimeScene';
import { haruhikageTemplate } from './haruhikage';
// 未在主 UI 展示、但完整可用的模板（WaveForge 全量注册）
import { battleTemplate } from './battle';
import { blueInkTemplate } from './blueInk';
import { cyberTemplate } from './cyber';
import { digitalImpressionTemplate } from './digitalImpression';
import { glitchTemplate } from './glitch';
import { holoScopeTemplate } from './holoScope';
import { kineticTemplate } from './kinetic';
import { p5Template } from './p5';
import { popArtTemplate } from './popArt';
import { rulerTemplate } from './ruler';
import { silhouetteCleanTemplate } from './silhouetteClean';
import { yorushikaTemplate } from './yorushika';

export const templates: TemplateConfig[] = [
  blueBoldTemplate,          // 0  蓝色冲击
  kineticSplitTemplate,      // 1  斩击
  bluePlaneTemplate,         // 2  蓝色构成(建议配合视频使用)
  cyberGrungeTemplate,       // 3  赛博废墟
  geometricTemplate,         // 4  几何
  rainCityTemplate,          // 5  黑客帝国
  cyberpunkHudTemplate,      // 6  夜之城监控(建议配合视频使用)
  emotionCinemaTemplate,     // 7  情绪电影(建议配合视频使用)
  hystericNightTemplate,     // 8  歇斯底里之夜(光敏慎点)
  spiderWebTemplate,         // 9  蛛网
  staggeredTextTplTemplate,  // 10 错落文字
  calmVillainTemplate,       // 11 冷静的反派
  girlyCloudTemplate,        // 12 少女云朵
  sweetPinkTemplate,         // 13 格子花边
  flyMeToTheMoonTemplate,    // 14 Fly Me to the Moon
  kawaiPixelTemplate,        // 15 Kawaii像素
  crimeSceneTemplate,        // 16 案发现场
  haruhikageTemplate,        // 17 春日影
  battleTemplate,            // 18 战斗
  blueInkTemplate,           // 19 青墨
  cyberTemplate,             // 20 赛博
  digitalImpressionTemplate, // 21 数字印象
  glitchTemplate,            // 22 故障
  holoScopeTemplate,         // 23 全息
  kineticTemplate,           // 24 动能
  p5Template,                // 25 P5 撕裂
  popArtTemplate,            // 26 波普
  rulerTemplate,             // 27 直尺
  silhouetteCleanTemplate,   // 28 剪影
  yorushikaTemplate,         // 29 夜鹿
];

export function getTemplate(name: string): TemplateConfig | undefined {
  return templates.find(t => t.name === name);
}