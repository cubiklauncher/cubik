// constants.js - 全应用共享的品牌与常量
const APP_NAME = 'Cubik';
const APP_VERSION = '1.4.1';
const APP_SLOGAN = '简洁易用的 Minecraft 启动器';
const OFFICIAL_SITE = 'https://github.com/cubiklauncher/cubik';
const REPO_URL = 'https://github.com/cubiklauncher/cubik';
// 法律文件主体
const LEGAL_AUTHOR = 'Cubik';
const LEGAL_EMAIL = '358670473@qq.com';
// 检查更新用：GitHub 仓库 owner/repo（发布到 GitHub 后改成真实仓库）
const UPDATE_REPO = 'cubiklauncher/cubik';

// 默认用户数据根目录（D 盘，避免占用系统盘）
const DATA_ROOT = 'D:\\CubikLauncher';

// 支持作者：赞赏收款码（图片路径或 dataURL）
// 留空则显示「作者暂未上传收款码」占位提示；填入 assets 下的相对路径或 dataURL 即可展示
const SUPPORT_QR_WECHAT = '';
const SUPPORT_QR_ALIPAY = '';
// 支持作者：反馈 / 开源仓库链接
const SUPPORT_ISSUES_URL = 'https://github.com/cubiklauncher/cubik/issues';

module.exports = {
  APP_NAME,
  APP_VERSION,
  APP_SLOGAN,
  OFFICIAL_SITE,
  REPO_URL,
  LEGAL_AUTHOR,
  LEGAL_EMAIL,
  UPDATE_REPO,
  DATA_ROOT,
  SUPPORT_QR_WECHAT,
  SUPPORT_QR_ALIPAY,
  SUPPORT_ISSUES_URL
};
