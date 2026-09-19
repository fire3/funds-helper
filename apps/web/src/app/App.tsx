import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Spinner } from '../components/ui.tsx';
import { WEB_TOOLS } from '../tools/registry.ts';
import { HomePage } from './Home.tsx';
import { AppLayout } from './Layout.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据是日频的，窗口焦点重取没有意义
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5 * 60_000,
    },
  },
});

function NotFoundPage() {
  return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">页面不存在</div>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />

            {WEB_TOOLS.map((tool) => (
              // `/*` 让「列表 → 详情」在同一路由内切换，组件不重挂载
              <Route
                key={tool.descriptor.id}
                path={`tools/${tool.descriptor.id}/*`}
                element={
                  <Suspense
                    fallback={
                      <div className="p-6">
                        <Spinner />
                      </div>
                    }
                  >
                    <tool.page />
                  </Suspense>
                }
              />
            ))}

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
