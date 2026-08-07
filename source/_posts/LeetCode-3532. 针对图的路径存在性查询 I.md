---
title: 3532. 针对图的路径存在性查询 I
tags:
  - LeetCode
  - 算法
  - Java
categories:
  - 算法
keywords:
  - LeetCode
  - 算法
  - Java
description: 记录 3532. 针对图的路径存在性查询 I 的解题过程
cover: ../img/java.jpg
date: 2026-07-09 20:25:23
updated:
top_img:
comments:
toc:
toc_number:
toc_style_simple:
copyright:
copyright_author:
copyright_author_href:
copyright_url:
copyright_info:
mathjax:
katex:
aplayer:
highlight_shrink:
aside:
abcjs:
---

## 原始题目信息

题目：**[3532. 针对图的路径存在性查询 I](https:leetcode.cn/problems/path-existence-queries-in-a-graph-i/)**

题目要求：

```text
给你一个整数 n，表示图中的节点数量，这些节点按从 0 到 n - 1 编号。

同时给你一个长度为 n 的整数数组 nums，该数组按 非递减 顺序排序，以及一个整数 maxDiff。

如果满足 |nums[i] - nums[j]| <= maxDiff（即 nums[i] 和 nums[j] 的 绝对差 至多为 maxDiff），则节点 i 和节点 j 之间存在一条 无向边 。

此外，给你一个二维整数数组 queries。对于每个 queries[i] = [ui, vi]，需要判断节点 ui 和 vi 之间是否存在路径。

返回一个布尔数组 answer，其中 answer[i] 等于 true 表示在第 i 个查询中节点 ui 和 vi 之间存在路径，否则为 false。

 

示例 1：

输入: n = 2, nums = [1,3], maxDiff = 1, queries = [[0,0],[0,1]]

输出: [true,false]

解释:

查询 [0,0]：节点 0 有一条到自己的显然路径。
查询 [0,1]：节点 0 和节点 1 之间没有边，因为 |nums[0] - nums[1]| = |1 - 3| = 2，大于 maxDiff。
因此，在处理完所有查询后，最终答案为 [true, false]。
示例 2：

输入: n = 4, nums = [2,5,6,8], maxDiff = 2, queries = [[0,1],[0,2],[1,3],[2,3]]

输出: [false,false,true,true]

解释:

查询 [0,1]：节点 0 和节点 1 之间没有边，因为 |nums[0] - nums[1]| = |2 - 5| = 3，大于 maxDiff。
查询 [0,2]：节点 0 和节点 2 之间没有边，因为 |nums[0] - nums[2]| = |2 - 6| = 4，大于 maxDiff。
查询 [1,3]：节点 1 和节点 3 之间存在路径通过节点 2，因为 |nums[1] - nums[2]| = |5 - 6| = 1 和 |nums[2] - nums[3]| = |6 - 8| = 2，都小于等于 maxDiff。
查询 [2,3]：节点 2 和节点 3 之间有一条边，因为 |nums[2] - nums[3]| = |6 - 8| = 2，等于 maxDiff。
因此，在处理完所有查询后，最终答案为 [false, false, true, true]。
```

## 解法

看到这个题，我一开始的解法就是模拟：

```java
class Solution {
    public boolean[] pathExistenceQueries(int n, int[] nums, int maxDiff, int[][] queries) {
        boolean[] result = new boolean[queries.length];
	
        // 遍历queries，拿到每对需要查询的节点
         for(int i = 0 ; i < queries.length ; i++){
             int u = queries[i][0];
             int v = queries[i][1];

             // 避免出现左大右小的情况，用于情况二的判断，因为题目说了是非递减数组。所以保证两节点从小到大，方便后续遍历，查询是否有间接相连边
             if(u > v){
                 int temp = u;
                 u = v;
                 v = temp;
             }
	
             // 情况一：
             // 判断两个节点，是否有无向边，可以直接看两节点间是否满足直接相连边的条件
             result[i] = maxDiff - Math.abs(nums[u] - nums[v]) >= 0;

             // 情况二：
             // 两节点没有直连，看看相邻的节点是否有相连边
             if(!result[i]){
                 int j = u;
                 for(; j <v ; j++){
                     if(maxDiff - Math.abs(nums[j+1] - nums[j]) < 0){
                         break;
                     }
                 }
                 if(j == v){
                      result[i] = true;
                 }
             }
         }
        return result;
    }
}
```

这个解法已经可以通过leetcode的所以测试用例了，那还有更好的解法吗？

有，而且可以更优雅：**不用真的建图，也不用每个 query 都循环检查一遍。**

关键点是：`nums` 已经按非递减排序。

如果相邻两个点 `i - 1` 和 `i` 满足：

```
nums[i] - nums[i - 1] <= maxDiff
```

那么它们之间一定有边，可以连起来。

如果出现：

```
nums[i] - nums[i - 1] > maxDiff
```

那么 `i - 1` 左边的所有点，和 `i` 右边的所有点之间都不可能连通。

因为 `nums` 是递增的，跨过这个断点只会差得更大。

所以问题可以转化成：

> 把所有节点按相邻差值是否超过 `maxDiff` 分成若干个连通块。
>  查询 `u` 和 `v` 是否在同一个连通块里。

------

## 更优雅写法：预处理连通块编号

```java
class Solution {
    public boolean[] pathExistenceQueries(int n, int[] nums, int maxDiff, int[][] queries) {
        // group[i] 表示节点 i 所在的连通块编号
        int[] group = new int[n];

        // 第 0 个节点属于第 0 个连通块
        group[0] = 0;

        for (int i = 1; i < n; i++) {
            // 如果相邻两个 nums 差值超过 maxDiff，说明这里断开了
            if ((long) nums[i] - nums[i - 1] > maxDiff) {
                group[i] = group[i - 1] + 1;
            } else {
                // 否则和前一个节点属于同一个连通块
                group[i] = group[i - 1];
            }
        }

        boolean[] answer = new boolean[queries.length];

        for (int i = 0; i < queries.length; i++) {
            int u = queries[i][0];
            int v = queries[i][1];

            // 只要连通块编号相同，就说明存在路径
            answer[i] = group[u] == group[v];
        }

        return answer;
    }
}
```

------

## 为什么这样可以？

假设：

```java
nums = [1, 3, 5, 10, 12]
maxDiff = 2
```

相邻差值：

```java
3 - 1 = 2   可以连
5 - 3 = 2   可以连
10 - 5 = 5  断开
12 - 10 = 2 可以连
```

所以连通块是：

```java
节点:   0  1  2 | 3  4
nums:   1  3  5 | 10 12
group:  0  0  0 | 1  1
```

查询：

```java
[0, 2] => group[0] == group[2] => true
[0, 4] => group[0] != group[4] => false
[3, 4] => group[3] == group[4] => true
```

## 举一反三

这道题用到的思想，本质叫：

**“先找断点，再分组；查询时只比较组号。”**

也可以理解成：

> 如果一个区间里没有“断开的地方”，那么区间两端就是连通的；
>  如果中间有断点，那么两边一定不连通。

------

### 一、这种思想适合什么类型的题？

以后看到下面几个特征，就可以优先想到这种方法。

#### 1. 数据已经排序

比如题目给你：

```java
nums 按非递减顺序排序
```

或者你自己可以先排序。

排序之后，很多问题就从“任意两个点之间的关系”，变成了“相邻两个点之间的关系”。

这道题就是这样。

原本边的定义是：

```java
|nums[i] - nums[j]| <= maxDiff
```

看起来好像要检查任意两个点。

但因为 `nums` 已经排序，所以真正决定连通性的，其实是相邻差值：

```java
nums[i] - nums[i - 1]
```

如果相邻都能连起来，那么整段就连起来了。

------

#### 2. 问的是“能不能到达”“是否连通”“是否存在路径”

比如题目问：

```java
u 和 v 是否存在路径？
```

或者：

```java
两个位置能不能互相到达？
```

或者：

```java
两个元素是否属于同一类？
```

这类题不关心具体路径是什么，只关心能不能连通。

那就很适合把节点提前分成若干组：

```java
group[i] = 节点 i 所在的组号
```

查询时只需要判断：

```java
group[u] == group[v]
```

------

#### 3. 中间只要出现一个“断点”，两边就不可能互通

这是最关键的判断。

这道题里的断点是：

```java
nums[i] - nums[i - 1] > maxDiff
```

一旦出现这个情况，说明：

```java
i - 1 和 i 连不上
```

因为数组是有序的，所以左边的数只会更小，右边的数只会更大。

因此左边和右边之间不可能通过其他点绕过去。

所以这里可以切成两组。

------

### 二、以后遇到这种题，可以按这个模板想

你可以在脑子里套这个流程：

```java
1. 题目是否有序？
2. 相邻元素之间能否定义“断开条件”？
3. 如果某处断开，左右两边是否一定无法互通？
4. 如果是，就可以预处理 group 数组。
5. 查询时比较 group 是否相同。
```

对应代码模板就是：

```java
int[] group = new int[n];

for (int i = 1; i < n; i++) {
    if (这里是断开条件) {
        group[i] = group[i - 1] + 1;
    } else {
        group[i] = group[i - 1];
    }
}

for (每个查询) {
    answer[i] = group[u] == group[v];
}
```

放到本题里，断开条件就是：

```java
nums[i] - nums[i - 1] > maxDiff
```

完整形式：

```java
int[] group = new int[n];

for (int i = 1; i < n; i++) {
    if (nums[i] - nums[i - 1] > maxDiff) {
        group[i] = group[i - 1] + 1;
    } else {
        group[i] = group[i - 1];
    }
}
```

------

### 三、举几个可以复用的题型

#### 类型一：路径存在性查询

题目特征：

```java
数组有序；
两个点满足某种差值条件就有边；
多次询问两个点是否连通。
```

典型思路：

```java
相邻差值 <= 限制：同一组
相邻差值 > 限制：断开，开启新组
```

本题就是这个类型。

------

#### 类型二：区间内是否全都满足某个条件

比如给你数组，问：

```java
[l, r] 这一段里面是否所有相邻元素差值都 <= k？
```

你也可以先找断点。

如果：

```java
nums[i] - nums[i - 1] > k
```

那么 `i - 1` 和 `i` 之间是断点。

然后给每一段编号。

如果：

```java
group[l] == group[r]
```

说明 `[l, r]` 中间没有断点。

如果不相等，说明中间有断点。

------

#### 类型三：按条件划分连续区间

比如：

```java
相邻两个数差值不超过 k，就属于同一段；
否则开启新段。
```

例如：

```java
nums = [1, 2, 4, 10, 11, 13]
k = 2
```

相邻差值：

```java
2 - 1 = 1    不断
4 - 2 = 2    不断
10 - 4 = 6   断开
11 - 10 = 1  不断
13 - 11 = 2  不断
```

分组结果：

```java
[1, 2, 4] | [10, 11, 13]
```

这种问题经常出现在：

```java
划分连续区间
判断元素是否属于同一段
统计有多少个连续块
```

------

#### 类型四：多次查询时，把重复计算提前做掉

你原来的代码是：

```java
每次 query 都从 u 扫到 v
```

如果查询很多，就会重复扫很多次。

优化思路是：

```java
先把所有断点提前算出来；
之后每个 query O(1) 回答。
```

这类思想很常见：

```java
多次查询 + 每次都重复扫描
```

一般都要想：

```java
能不能预处理？
能不能用前缀和？
能不能用分组编号？
能不能用并查集？
```

------

### 四、这个思想和并查集有什么关系？

这道题也可以用并查集做：

```java
如果 nums[i] - nums[i - 1] <= maxDiff，就 union(i - 1, i)
```

最后查询：

```java
find(u) == find(v)
```

但因为节点天然是按顺序排列的，而且只需要判断相邻断点，所以没必要真的用并查集。

这道题中：

```java
group 数组
```

其实就是一种更简单的并查集替代品。

可以这样理解：

```java
普通图连通性：用并查集
有序数组上的连续连通性：用 group 编号
```

------

### 五、什么时候不能用这种思想？

不是所有连通性题都能这样做。

如果图的连接关系不是按顺序连续的，比如：

```java
0 和 5 连
5 和 9 连
2 和 7 连
```

这种连接很跳跃，不是简单的相邻关系，那就不能只靠断点分组。

这时候通常要用：

```java
并查集
DFS
BFS
图搜索
```

再比如，如果数组不是有序的，而且排序会改变节点之间的原始关系，也不能乱用。

------

### 六、你以后可以这样识别

看到题目里有这些关键词，就要敏感：

```java
数组已排序
非递减
相邻
差值不超过 k
是否存在路径
是否连通
多次查询
区间查询
能否到达
```

尤其是这几个组合出现时：

```java
有序数组 + 差值限制 + 连通性查询
```

优先想到：

```java
找断点，分组编号。
```

------

### 七、一句话总结

这类题的核心思想是：

```java
在有序结构中，真正决定连通性的往往不是任意两点，而是相邻两点。
相邻不断，则整段连通；
相邻断开，则左右分裂。
所以可以先预处理每个点属于哪个连通块，再 O(1) 回答查询。
```

以后遇到类似题，不要一上来就建图、DFS、BFS。

先问自己一句：

```java
这个图是不是其实可以被切成几个连续段？
```

如果答案是，那大概率就能用这套方法。

