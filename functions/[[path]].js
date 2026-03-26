// Cloudflare Pages Functions 主入口文件
// 处理所有路径的请求

// 导入主逻辑
import handler from '../worker.js';

// Pages Functions 入口函数
export async function onRequest(context) {
  // 调用主逻辑处理请求
  return await handler.fetch(context.request, context.env, context);
}
