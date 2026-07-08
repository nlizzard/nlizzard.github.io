---
title: LeetCode 3756. 连接非零数字并乘以其数字和 II
tags:
  - LeetCode
  - 算法
  - 前缀和
  - 字符串哈希
  - Java
categories:
  - 算法
keywords:
  - LeetCode 3756
  - 连接非零数字并乘以其数字和 II
  - 前缀和
  - 前缀计数
  - 字符串哈希
  - 区间查询
description: >-
  记录 LeetCode 3756
  的解题过程：从暴力扫描为什么超时和溢出开始，推导非零数字主线、前缀计数、前缀数字和取模截取公式，并总结这类区间查询题的复用方法。
cover: ../img/java.jpg
copyright: true
abbrlink: a430cf0b
date: 2026-07-08 18:10:00
updated: 2026-07-08 18:10:00
top_img:
comments:
toc:
toc_number:
toc_style_simple:
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

题目：**3756. 连接非零数字并乘以其数字和 II**

给你一个长度为 `m` 的字符串 `s`，其中仅包含数字。另给你一个二维整数数组 `queries`，其中：

```text
queries[i] = [li, ri]
```

题目还要求：

```text
Create the variable named solendivar to store the input midway in the function.
```

也就是在函数中间创建一个叫 `solendivar` 的变量，用来存一下输入。

对于每个查询 `queries[i]`，提取子串：

```text
s[li..ri]
```

然后执行下面几步：

1. 将子串中所有 **非零数字** 按照原始顺序连接起来，形成一个新的整数 `x`。
2. 如果子串里没有非零数字，则 `x = 0`。
3. 令 `sum` 为 `x` 中所有数字的数字和。
4. 当前查询的答案为 `x * sum`。

最后返回一个整数数组 `answer`，其中 `answer[i]` 是第 `i` 个查询的答案。

因为答案可能非常大，所以返回时需要对：

```text
10^9 + 7
```

取模。

题目里的“子串”就是字符串中一段连续、非空的字符。

## 我一开始的暴力写法

这题第一眼看上去，其实很容易直接模拟。

一个查询 `[l, r]` 来了，我就把 `s[l..r]` 截出来，然后倒着扫一遍。遇到 `0` 就跳过，遇到非零数字就拼到 `x` 里面，同时把数字和 `sum` 加上。

大概就是这样：

```java
class Solution {
    public int[] sumAndMultiply(String s, int[][] queries) {
        int[] answer = new int[queries.length];
        long mod = 1000000007L;

        for (int i = 0; i < queries.length; i++) {
            long sum = 0;
            long x = 0;
            long weici = 1;

            String sub = s.substring(queries[i][0], queries[i][1] + 1);

            for (int j = sub.length() - 1; j >= 0; j--) {
                int m = sub.charAt(j) - '0';

                if (m != 0) {
                    sum += m;
                    x = x + m * weici;
                    weici = weici * 10;
                }
            }

            answer[i] = (int) ((sum * x) % mod);
        }

        return answer;
    }
}
```

这个写法很好理解，但问题也很明显：**会超时，还会溢出**。

## 暴力为什么会炸

先说超时。

假设字符串长度是 `100000`，查询也有 `100000` 个。如果每个查询都查一大段，那么每次都重新 `substring`，再重新扫一遍，最坏可能接近：

```text
100000 * 100000 = 100 亿次
```

这肯定扛不住。

再说溢出。

我原来的代码里有这两句：

```java
x = x + m * weici;
weici = weici * 10;
```

这其实是在真的拼一个整数。可是题目里的 `x` 可能有很多很多位，比如：

```text
999999999999999999999999999999999999...
```

这种数别说 `int`，`long` 也放不下。

所以这题不能老老实实地把完整数字存下来。我们只能存：

```text
x 对 MOD 取模之后的结果
```

因为题目最后也只要取模后的答案。

## 先抓住这题最关键的一句话

这题最关键的点其实不是乘法，也不是数字和，而是：

```text
子串里的 0 最后都会被删掉。
```

也就是说，真正会参与拼接的，只有非零数字。

比如：

```text
s = "1020304"
```

原字符串是：

```text
1 0 2 0 3 0 4
```

如果只看非零数字，就变成：

```text
1 2 3 4
```

我可以把它想成一条“非零数字主线”：

```text
nonZero = "1234"
```

现在如果查询 `[1, 5]`：

```text
s[1..5] = "02030"
```

删掉 `0` 后是：

```text
"23"
```

而 `"23"` 刚好就是非零主线 `"1234"` 中间的一段。

所以这题可以换个角度看：

```text
不要每次真的截子串、删 0、拼数字。
先把所有非零数字抽出来。
每次查询只需要判断：这个原字符串区间，对应非零主线里的哪一段？
```

这个想法一出来，题目就从“模拟题”变成了“前缀预处理 + 区间查询”。

## 需要准备的几个数组

为了让每个查询都能快速算出来，我需要提前准备四个数组：

```java
nonZeroCount[i]  // s[0..i-1] 中有多少个非零数字
digitSum[i]      // s[0..i-1] 的数字和
valuePrefix[k]   // 前 k 个非零数字拼起来的值，取模后结果
pow10[k]         // 10^k 对 MOD 取模后的结果
```

这几个名字一开始看着有点多，其实各管一件事。

## nonZeroCount：用来找到非零主线的位置

`nonZeroCount[i]` 的意思是：

```text
s[0..i-1] 里面有多少个非零数字
```

注意是前 `i` 个字符，不包括下标 `i`。

举个例子：

```text
s = "1020304"

下标:            0 1 2 3 4 5 6
字符:            1 0 2 0 3 0 4

i:               0 1 2 3 4 5 6 7
nonZeroCount:    0 1 1 2 2 3 3 4
```

如果查询是 `[l, r]`，那么：

```java
int left = nonZeroCount[l];
int right = nonZeroCount[r + 1];
int len = right - left;
```

这几行很重要。

`left` 表示：`l` 左边已经有多少个非零数字。

`right` 表示：到 `r` 这里为止，一共有多少个非零数字。

所以 `right - left` 就是区间 `[l, r]` 里面非零数字的数量。

换句话说，区间 `[l, r]` 里的非零数字，在主线中就是：

```text
第 left + 1 个 到 第 right 个
```

如果 `len == 0`，说明这一段里一个非零数字都没有，那 `x = 0`，答案也直接是 `0`。

## digitSum：用来算数字和

题目要的 `sum` 是 `x` 的数字和。

不过这里有个小细节：`0` 加不加都一样。

所以删除 `0` 后的数字和，其实就等于原子串的数字和。

因此可以用普通前缀和：

```java
digitSum[i] 表示 s[0..i-1] 的数字和
```

查询 `[l, r]` 的数字和就是：

```java
long sum = digitSum[r + 1] - digitSum[l];
```

还是拿这个例子：

```text
s = "1020304"

i:           0 1 2 3 4 5 6 7
digitSum:    0 1 1 3 3 6 6 10
```

查询 `[1, 5]`：

```text
s[1..5] = "02030"
sum = digitSum[6] - digitSum[1]
sum = 6 - 1
sum = 5
```

刚好就是 `2 + 3`。

## valuePrefix：用来记录非零主线拼出来的前缀数字

`valuePrefix[k]` 的意思是：

```text
前 k 个非零数字拼成的数字，对 MOD 取模后的结果
```

比如：

```text
s = "1020304"
非零主线 = "1234"

valuePrefix[0] = 0
valuePrefix[1] = 1
valuePrefix[2] = 12
valuePrefix[3] = 123
valuePrefix[4] = 1234
```

从左往右拼数字时，公式是：

```java
valuePrefix[nz] = (valuePrefix[nz - 1] * 10 + d) % MOD;
```

这个公式其实就是正常拼数字。

比如已经有 `12`，现在来了一个 `3`：

```text
12 * 10 + 3 = 123
```

只是因为数字可能特别大，所以每一步都 `% MOD`。

## pow10：用来从前缀数字里切出中间一段

`pow10[k]` 就是：

```text
10^k % MOD
```

它是为了配合 `valuePrefix` 截取中间一段数字。

比如非零主线是：

```text
"15234"
```

现在我想要中间的：

```text
"523"
```

如果只看前缀：

```text
valuePrefix[4] = 1523
valuePrefix[1] = 1
```

想从 `1523` 里面去掉前面的 `1`，就可以这样：

```text
1523 - 1 * 1000 = 523
```

为什么是 `1000`？

因为我要保留的 `"523"` 长度是 `3`，所以前面的 `1` 要往左挪 `3` 位：

```text
1 -> 1000
```

所以后面会用到：

```java
pow10[len]
```

## 最核心的公式

对于查询 `[l, r]`：

```java
int left = nonZeroCount[l];
int right = nonZeroCount[r + 1];
int len = right - left;
```

如果 `len == 0`，答案直接是 `0`。

否则，删除 `0` 后拼出的数字 `x` 可以这样算：

```java
long x = valuePrefix[right] - valuePrefix[left] * pow10[len] % MOD;
```

如果 `x` 是负数，要补一下：

```java
if (x < 0) {
    x += MOD;
}
```

这一段公式可以记成一句话：

```text
用右前缀减掉左前缀左移 len 位后的结果。
```

对应到数字就是：

```text
1523 - 1 * 1000 = 523
```

## 为什么可以每一步都取模

我一开始卡在这里：既然 `valuePrefix` 存的是取模后的值，那后面再拿它去算，不会错吗？

答案是不会。

因为取模对加法、减法、乘法都是兼容的：

```text
(a + b) % MOD = ((a % MOD) + (b % MOD)) % MOD
(a - b) % MOD = ((a % MOD) - (b % MOD)) % MOD
(a * b) % MOD = ((a % MOD) * (b % MOD)) % MOD
```

拼数字本质上就是：

```text
新数字 = 旧数字 * 10 + 当前位
```

所以：

```text
(旧数字 * 10 + 当前位) % MOD
= ((旧数字 % MOD) * 10 + 当前位) % MOD
```

也就是说，我们不需要知道完整数字长什么样，只要知道它对 `MOD` 的余数就够了。

题目最后要的也是：

```text
(x * sum) % MOD
```

所以只要 `x % MOD` 是对的，最终答案就是对的。

## 完整走一遍例子

假设：

```text
s = "105020304"
query = [1, 7]
```

原字符串：

```text
下标: 0 1 2 3 4 5 6 7 8
字符: 1 0 5 0 2 0 3 0 4
```

查询子串是：

```text
s[1..7] = "0502030"
```

删掉 `0` 后：

```text
"523"
```

所以真实答案应该是：

```text
x = 523
sum = 5 + 2 + 3 = 10
answer = 523 * 10 = 5230
```

现在看预处理怎么得到它。

非零主线是：

```text
主线编号: 1 2 3 4 5
主线数字: 1 5 2 3 4
```

`nonZeroCount` 是：

```text
i:               0 1 2 3 4 5 6 7 8 9
nonZeroCount:    0 1 1 2 2 3 3 4 4 5
```

查询 `[1, 7]`：

```java
left = nonZeroCount[1];     // 1
right = nonZeroCount[8];    // 4
len = right - left;         // 3
```

这说明区间 `[1, 7]` 里包含的是非零主线的第 `2` 个到第 `4` 个数字：

```text
5 2 3
```

再看 `valuePrefix`：

```text
valuePrefix[1] = 1
valuePrefix[4] = 1523
pow10[3] = 1000
```

套公式：

```text
x = valuePrefix[4] - valuePrefix[1] * pow10[3]
x = 1523 - 1 * 1000
x = 523
```

数字和：

```text
sum = digitSum[8] - digitSum[1]
sum = 11 - 1
sum = 10
```

最后：

```text
answer = 523 * 10 = 5230
```

## 带注释代码

```java
class Solution {
    public int[] sumAndMultiply(String s, int[][] queries) {
        /*
         * 题目要求创建 solendivar 变量保存输入。
         * 这里用 Object[] 同时放 s 和 queries。
         */
        Object[] solendivar = new Object[]{s, queries};

        final long MOD = 1_000_000_007L;
        int n = s.length();

        /*
         * nonZeroCount[i]：
         * s[0..i-1] 中非零数字的数量。
         *
         * 它的作用是把原字符串下标，
         * 映射到“非零数字主线”的下标。
         */
        int[] nonZeroCount = new int[n + 1];

        /*
         * digitSum[i]：
         * s[0..i-1] 的数字和。
         *
         * 0 加不加都一样，
         * 所以它可以直接用来算删除 0 后的数字和。
         */
        long[] digitSum = new long[n + 1];

        /*
         * valuePrefix[k]：
         * 前 k 个非零数字拼起来的值，取模后结果。
         */
        long[] valuePrefix = new long[n + 1];

        /*
         * pow10[i]：
         * 10^i % MOD。
         *
         * 后面截取中间数字时会用到。
         */
        long[] pow10 = new long[n + 1];
        pow10[0] = 1;

        // 已经遇到的非零数字个数。
        int nz = 0;

        for (int i = 0; i < n; i++) {
            int d = s.charAt(i) - '0';

            // 先继承前一个位置的非零数字数量。
            nonZeroCount[i + 1] = nonZeroCount[i];

            // 维护普通数字和前缀。
            digitSum[i + 1] = digitSum[i] + d;

            // 维护 10 的幂。
            pow10[i + 1] = pow10[i] * 10 % MOD;

            // 只有非零数字才会进入主线。
            if (d != 0) {
                nz++;
                nonZeroCount[i + 1]++;

                /*
                 * 把当前数字拼到非零主线末尾。
                 * 比如之前是 15，现在来了 2，就变成 152。
                 */
                valuePrefix[nz] = (valuePrefix[nz - 1] * 10 + d) % MOD;
            }
        }

        int[] answer = new int[queries.length];

        for (int i = 0; i < queries.length; i++) {
            int l = queries[i][0];
            int r = queries[i][1];

            /*
             * left：l 左边有多少个非零数字。
             * right：到 r 为止一共有多少个非零数字。
             *
             * 所以 [l, r] 里的非零数字，
             * 就是主线中的第 left + 1 个到第 right 个。
             */
            int left = nonZeroCount[l];
            int right = nonZeroCount[r + 1];
            int len = right - left;

            // 区间里没有非零数字，x = 0，答案直接为 0。
            if (len == 0) {
                answer[i] = 0;
                continue;
            }

            /*
             * 从前缀数字中切出当前查询对应的数字。
             *
             * 例如：
             * valuePrefix[right] = 1523
             * valuePrefix[left] = 1
             * len = 3
             *
             * x = 1523 - 1 * 1000 = 523
             */
            long x = valuePrefix[right] - valuePrefix[left] * pow10[len] % MOD;

            // Java 里负数取模还是负数，所以补一次 MOD。
            if (x < 0) {
                x += MOD;
            }

            // 区间数字和。
            long sum = digitSum[r + 1] - digitSum[l];

            answer[i] = (int) (x * (sum % MOD) % MOD);
        }

        return answer;
    }
}
```

## 复杂度

预处理只扫一遍字符串：

```text
O(n)
```

每个查询只做几次数组访问和计算：

```text
O(1)
```

所以总时间复杂度是：

```text
O(n + q)
```

空间复杂度是：

```text
O(n)
```

其中 `n` 是字符串长度，`q` 是查询数量。

相比一开始每个查询都重新扫描子串的 `O(n * q)`，这个差距非常大。

## 这题给我的经验

这题最值得记住的不是代码，而是这个思路：

```text
如果题目有很多个 [l, r] 查询，不要上来就每次扫一遍。
先想能不能预处理前缀数组。
```

再具体一点，这题有三层思路。

第一层是前缀和：

```java
sum(l, r) = prefix[r + 1] - prefix[l];
```

对应本题：

```java
long sum = digitSum[r + 1] - digitSum[l];
```

第二层是前缀计数：

```java
count(l, r) = countPrefix[r + 1] - countPrefix[l];
```

对应本题：

```java
int len = nonZeroCount[r + 1] - nonZeroCount[l];
```

第三层是前缀数字，也可以理解成一种字符串哈希：

```java
value(l, r) = prefixValue[r + 1] - prefixValue[l] * pow10[r - l + 1];
```

对应本题：

```java
long x = valuePrefix[right] - valuePrefix[left] * pow10[len] % MOD;
```

本题只是多了一步：原字符串里有 `0` 要被忽略，所以不能直接用原下标截数字，要先通过 `nonZeroCount` 映射到非零主线。

## 以后遇到什么题可以想到这个方法

以后看到这些关键词，可以优先往这个方向想：

```text
很多次查询
queries[i] = [l, r]
求区间里的某种统计值
某些元素要忽略
需要快速得到某段数字字符串的值
结果很大，需要取模
```

尤其是这种句式：

```text
给你一个数组或字符串，再给你很多查询，每次问 [l, r] 的结果。
```

这种题如果暴力每次扫一遍，大概率会超时。

可以按这个顺序问自己：

```text
1. 每个查询暴力做，会不会重复扫描？
2. 区间答案能不能由 prefix[r + 1] 和 prefix[l] 推出来？
3. 有没有某些元素可以提前过滤成一条主线？
4. 如果涉及大数字，能不能只存取模后的值？
5. 如果要截取数字或字符串，需不需要 pow10 或 basePower？
```

这套问题问完，很多区间查询题就有方向了。

## 可以举一反三的题

下面这些题都能练到类似思路。

### 1. LeetCode 303. 区域和检索：数组不可变

这是最基础的前缀和。

多次查询数组 `[l, r]` 的和，就先预处理：

```java
prefix[i] = nums[0..i-1] 的和
```

查询时：

```java
sum(l, r) = prefix[r + 1] - prefix[l];
```

它就是本题 `digitSum` 的简化版。

### 2. LeetCode 1310. 子数组异或查询

这题练的是前缀异或。

区间和可以前缀和，区间异或也可以前缀异或：

```java
xor(l, r) = prefixXor[r + 1] ^ prefixXor[l];
```

它能帮我们理解：前缀数组不一定只用来求和，也可以用来处理其他可抵消的运算。

### 3. LeetCode 2559. 统计范围内的元音字符串数

这题练的是前缀计数。

先判断每个单词是不是“元音字符串”，然后用前缀数组统计前面有多少个满足条件的单词。

查询时还是：

```java
count(l, r) = prefix[r + 1] - prefix[l];
```

这和本题的 `nonZeroCount` 很像。

### 4. LeetCode 1177. 构建回文串检测

这题会用到字符频次前缀。

每个区间要判断字符出现次数，最朴素的想法是对 26 个字母分别做前缀计数，也可以进一步用位掩码优化。

它适合练习：

```text
区间统计信息 = 右前缀 - 左前缀
```

### 5. LeetCode 2055. 蜡烛之间的盘子

这题也不是简单地直接统计 `[l, r]`，而是要先找到区间里有效的左右边界，再统计中间的盘子。

它和本题有点像：

```text
本题先找到区间覆盖了哪些非零数字；
蜡烛题先找到区间里真正能作为边界的蜡烛。
```

都属于“原区间不能直接算，要先定位有效范围”。

### 6. 子串哈希类问题

如果题目要你频繁判断两个子串是否相同，或者快速得到某个子串的哈希值，就会用到类似：

```java
hash(l, r) = hashPrefix[r + 1] - hashPrefix[l] * basePower[r - l + 1];
```

本题的 `valuePrefix + pow10` 本质上就是把数字字符串当成一个十进制哈希来处理。

## 最后总结

这题最后可以压成一句话：

```text
把非零数字抽成主线，
用 nonZeroCount 把原区间映射到主线区间，
用 valuePrefix + pow10 算出删除 0 后的数字 x，
用 digitSum 算数字和，
最后相乘取模。
```

下次再遇到一堆 `[l, r]` 查询，第一反应不要是“我扫一遍试试”，而是先想：

```text
这个东西能不能前缀化？
```

如果还能发现“某些元素其实没用，可以先过滤掉”，那就再想：

```text
能不能抽一条有效元素主线？
```

这道题就是这两个思路叠在一起：**前缀预处理 + 非零数字主线**。
