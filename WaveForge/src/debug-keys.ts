// 调试空 key 的工具
export function debugEmptyKeys() {
  const originalConsoleError = console.error;
  console.error = function(...args: any[]) {
    const message = args[0];
    if (typeof message === 'string' && message.includes('Encountered two children with the same key')) {
      console.log('🔴 捕获到空 key 警告！');
      console.trace('堆栈跟踪：');
      
      // 尝试找出是哪个组件
      const error = new Error();
      const stack = error.stack;
      console.log('完整堆栈：', stack);
    }
    originalConsoleError.apply(console, args);
  };
  
  console.log('✅ 空 key 调试已启动');
}
