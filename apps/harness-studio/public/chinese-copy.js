// Display only. Never use translated text as a project ID, filename or model parameter.
const terms = [
 ['RunningHub','云端工作流平台'],['Blender','三维制作工具'],['TVC','广告片'],['PCM','无压缩音频'],['VIP','高级版'],['Director','导演'],['Engine','引擎'],
 ['canonical_open','独立起镜'],['editorial_cut','剪辑衔接'],['continuous_proxy_handoff','连续动作衔接'],
 ['Director Engine','导演引擎'],['Harness Studio','导演工作台'],['Legacy v1','旧版项目'],
 ['A-roll','人物口播画面'],['B-roll','补充画面'],['KOC','口播人物复刻'],['AI','人工智能'],
 ['Harness','制作流程'],['LibTV','立布视频平台'],['Shotlist','镜头清单'],['JSON','结构化资料'],
 ['SHA256','文件校验指纹'],['SHA','文件校验指纹'],['UUID','系统编号'],['ID','编号'],
 ['PASS','通过'],['FAIL','未通过'],['COMPLETE','已完成'],['SUCCESS','成功'],['FAILED','失败'],
 ['RUNNING','执行中'],['QUEUED','排队中'],['READY','已就绪'],['AVAILABLE','可用'],['REQUIRED','必需'],['OPTIONAL','可选'],
 ['draft','草稿'],['locked','已锁定'],['awaiting_review','等待审核'],['rework','需要修改'],
 ['HTTP','网络请求'],['LAN','局域网'],['API','接口'],['CLI','命令行工具'],['Skill','能力模块'],
 ['ffprobe','媒体规格检测工具'],['task','任务'],['fps','帧每秒']
];
export function chineseInterfaceText(value) {
 let text = String(value);
 text = text.replace(/asset manifest item ([A-Za-z0-9._:-]+) does not match its locked project-state artifact/g, '素材清单与项目中已锁定的素材不一致，请检查素材绑定');
 text = text.replace(/a locked segmentation artifact is required/g, '需要先确认并锁定分段方案');
 text = text.replace(/(?<![A-Za-z0-9_./:-])segment-0*(\d+)(?![A-Za-z0-9_./:-])/g, (_, n) => `第${Number(n)}段`);
 text = text.replace(/U形/g, '开口向上的弧形');
 text = text.replace(/(?<![A-Za-z0-9_./:-])v(\d+)(?![A-Za-z0-9_./:-])/g, '第$1版');
 text = text.replace(/(?<![A-Za-z0-9_./:-])(\d+)p\b/g, '画面高度$1像素');
 text = text.replace(/\bGate\s*([0-5])\b/g, (_, n) => ['需求确认','创意审核','故事与镜头审核','素材审核','生成前审核','成片审核'][Number(n)]);
 text = text.replace(/\bGate\b/g, '审核环节');
 for (const [source, target] of terms) {
   const escaped = source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   text = text.replace(new RegExp(`(?<![A-Za-z0-9_./:-])${escaped}(?![A-Za-z0-9_./:-])`,'g'), target);
 }
 return text;
}
export function displayNumber(value) {
 let hash = 2166136261;
 for (const c of String(value)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
 return String(hash).padStart(10,'0');
}
export function chineseProjectName(project) {
 const original = project?.displayName || project?.status?.projectId || project?.slug || '';
 const chinese = original.replace(/[A-Za-z0-9_./:-]+/g, '').trim();
 return /[A-Za-z]/.test(original) ? `${chinese || '视频项目'} · ${displayNumber(original)}` : original || '未命名项目';
}
export function chineseSegmentName(segment) {
 const value = String(segment?.id ?? '');
 const match = /^(?:segment|face-package)-0*(\d+)$/.exec(value);
 if (match) return `第${Number(match[1])}段`;
 if (value === 'full-source-timeline') return '完整原片';
 return /[A-Za-z]/.test(value) ? `片段 · ${displayNumber(value)}` : value || '共用素材';
}
export function chineseMediaName(artifact, index = 0) {
 const custom = artifact.title || artifact.name;
 if (custom && !/[A-Za-z]/.test(custom)) return custom;
 const ext = String(artifact.path ?? '').split('.').pop().toLowerCase();
 const kind = /^(mp4|mov|webm|m4v)$/.test(ext) ? '视频' : /^(wav|mp3|m4a|aac|ogg|flac)$/.test(ext) ? '音频' : '图片';
 return `${artifact.segmentId ? chineseSegmentName({id:artifact.segmentId}) + ' · ' : ''}${kind}素材 ${index + 1}`;
}
