---
title: MapStruct 使用指南：用示例讲清 Java 对象映射
tags:
  - MapStruct
  - Java
  - Spring Boot
categories:
  - java
keywords:
  - MapStruct
  - Java对象转换
  - DTO
  - VO
  - Spring Boot
description: 通过一组循序渐进的示例，介绍 MapStruct 的基础映射、字段重命名、嵌套对象、类型转换、集合、多数据源、对象更新、空值策略、枚举和自定义转换。
cover: ../img/java.jpg
copyright: true
abbrlink: 51ee8b2b
date: 2026-06-12 13:00:00
updated:
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

## 1. MapStruct 简介

在 Java 项目中，我们经常需要在不同对象之间转换数据，例如：

- 将数据库实体 `Entity` 转换为接口返回的 `DTO` 或 `VO`
- 将前端提交的 `Command` 转换为领域对象
- 合并多个查询结果，组装成一个页面展示对象
- 更新已有对象，而不是创建一个新对象

字段少时可以手写 `set` 方法，字段多了以后，转换代码就会变得重复且容易遗漏。`BeanUtils.copyProperties()` 虽然使用方便，但映射规则不够直观，字段改名、类型不同、嵌套对象等场景仍然需要额外处理。

MapStruct 是一个基于 Java 注解处理器的对象映射代码生成器。开发者只需要定义 Mapper 接口，并通过 `@Mapper`、`@Mapping` 等注解描述转换规则，MapStruct 就会在编译阶段生成对应的实现类。

它的思路是：**我们声明对象之间如何映射，MapStruct 负责生成普通的 Java 转换代码**。生成的代码通常就是判空、调用 getter 和 setter，因此容易阅读和调试，也能在编译阶段发现字段不存在、类型无法转换等问题。

本文基于 MapStruct `1.6.3`，通过示例介绍项目中最常见的用法。

## 2. 核心工作原理

MapStruct 并不会在程序运行时通过反射临时分析对象，而是把映射工作提前到了编译阶段。完整过程可以概括为：

1. 开发者声明 Mapper 接口和映射规则。
2. Maven、Gradle 或 IDE 调用 Java 编译器。
3. `mapstruct-processor` 读取 `@Mapper`、`@Mapping` 等注解。
4. 注解处理器检查源类型、目标类型、属性名称和可用转换方法。
5. MapStruct 生成 Mapper 实现类，并与其他 Java 源码一起编译。
6. 程序运行时直接调用生成类中的普通 Java 方法。

> Mapper 接口与映射注解 → Java 编译器 → MapStruct 注解处理器 → 检查字段与类型 → 生成 `MapperImpl` → 编译为字节码 → 运行时直接调用

例如声明一个方法：

```java
@Mapper
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    UserDTO toDTO(UserEntity entity);
}
```

编译后会生成类似下面的实现：

```java
public class UserMapperImpl implements UserMapper {

    @Override
    public UserDTO toDTO(UserEntity entity) {
        if (entity == null) {
            return null;
        }

        UserDTO dto = new UserDTO();
        dto.setName(entity.getUsername());
        dto.setId(entity.getId());
        return dto;
    }
}
```

因此，MapStruct 的运行过程与手写 getter、setter 基本相同。它没有运行时映射规则解析过程，生成代码也可以直接打断点调试。

## 3. 核心优势

### 3.1 接近手写代码的运行方式

MapStruct 生成的是直接属性调用代码，不需要在每次转换时使用反射查找字段或方法。实际性能仍会受到对象结构、JVM、测试方式等因素影响，但从执行机制看，它通常与手写映射处于同一量级。

### 3.2 编译阶段检查

如果 `source` 指定的字段不存在、目标属性不可写，或者两个类型之间没有可用的转换方法，MapStruct 通常会在编译阶段报错。这样可以让字段变更尽早暴露，而不是等到接口运行时才发现问题。

### 3.3 映射规则清晰

字段重命名、忽略字段、日期格式化、嵌套属性和自定义转换都可以集中声明在 Mapper 中。与散落在 Service 里的大量 `set` 方法相比，对象之间的关系更加直观。

### 3.4 生成代码可读、可调试

生成的 `MapperImpl` 是普通 Java 类。遇到判空、集合转换或自定义方法选择不符合预期时，可以直接查看生成源码，而不是面对隐藏在工具内部的运行时行为。

### 3.5 容易与现有项目集成

MapStruct 可以独立使用，也可以通过 `componentModel` 集成 Spring、CDI 和 Jakarta CDI。它还支持集合、枚举、Builder、记录类、多源参数和已有对象更新等常见场景。

### 3.6 降低重复代码，但不隐藏业务逻辑

MapStruct 适合消除机械的对象转换代码，同时允许开发者显式指定特殊规则。它负责“数据如何搬运”，数据库查询、权限判断和状态流转等业务逻辑仍应留在 Service 或领域层。

## 4. 主流方案对比

选择对象映射方案时，不能只看某一次性能测试的毫秒数。对象数量、字段规模、嵌套层级、JVM 预热和测试环境都会影响结果。更有参考价值的是比较各方案的实现机制、编译检查能力和维护成本。

### 4.1 综合对比

| 方案 | 核心机制 | 编译检查 | 嵌套与复杂映射 | 运行时特点 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| **MapStruct** | 编译期注解处理器生成 Java 代码 | 强 | 强，规则显式 | 接近手写代码，无运行时反射映射 | DTO 较多、重视性能和可维护性的新项目 |
| **MapStruct-Plus** | 基于 MapStruct 的第三方增强方案 | 强 | 强，进一步自动化 | 延续 MapStruct 的生成代码方式 | 希望减少 Mapper 模板代码，并能接受额外框架约定的项目 |
| **手写转换** | 直接调用 getter、setter | 强 | 最灵活 | 通常是性能上限，无额外依赖 | 映射数量少、规则特殊或要求完全可控 |
| **Spring BeanUtils** | 运行时属性描述与方法调用 | 弱 | 较弱，主要处理同名兼容属性 | 使用简单，但缺少映射规则的编译期保证 | Spring 项目中的少量、简单、临时属性复制 |
| **ModelMapper** | 运行时智能匹配与反射 | 弱 | 强，配置灵活 | 需要在运行时分析和匹配映射关系 | 快速原型、命名规范且映射规则变化较多的项目 |
| **Orika** | 运行时生成并缓存映射字节码 | 较弱 | 强 | 首次生成存在成本，缓存后性能较好 | 已使用 Orika 的旧项目或复杂映射改造 |
| **Apache Commons BeanUtils** | 运行时内省、反射和类型转换 | 弱 | 较弱 | 运行时开销较大，类型转换行为需要谨慎 | 维护遗留代码，不建议作为新项目首选 |

> MapStruct-Plus 不是 MapStruct 官方组件，而是建立在 MapStruct 之上的第三方增强工具。是否采用它，需要同时考虑团队规范、框架升级和额外依赖。

### 4.2 如何选择

- **映射很少且规则特殊**：手写代码最直接，不必为了几个方法额外引入框架。
- **Spring 项目中偶尔复制简单对象**：`Spring BeanUtils` 使用方便，但应确保属性名称和类型兼容。
- **快速原型或依赖约定自动匹配**：可以考虑 `ModelMapper`。
- **遗留项目已经使用 Orika**：没有明确收益时，不必仅为更换工具进行大规模重构。
- **DTO、VO 数量较多，且重视性能、类型安全和长期维护**：优先考虑 MapStruct。
- **希望在 MapStruct 基础上进一步减少模板代码**：评估 MapStruct-Plus，但要明确它属于第三方增强层。

综合来看，MapStruct 的优势不是某一项指标绝对领先，而是在**运行效率、编译检查、可读性和开发成本之间取得了较好的平衡**。

## 5. 引入 MapStruct

### 5.1 Maven 配置

MapStruct 包含两部分：

- `mapstruct`：提供运行时使用的注解
- `mapstruct-processor`：注解处理器，在编译阶段生成 Mapper 实现类

```xml
<properties>
    <java.version>17</java.version>
    <mapstruct.version>1.6.3</mapstruct.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.mapstruct</groupId>
        <artifactId>mapstruct</artifactId>
        <version>${mapstruct.version}</version>
    </dependency>
</dependencies>

<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-compiler-plugin</artifactId>
            <version>3.13.0</version>
            <configuration>
                <source>${java.version}</source>
                <target>${java.version}</target>
                <annotationProcessorPaths>
                    <path>
                        <groupId>org.mapstruct</groupId>
                        <artifactId>mapstruct-processor</artifactId>
                        <version>${mapstruct.version}</version>
                    </path>
                </annotationProcessorPaths>
            </configuration>
        </plugin>
    </plugins>
</build>
```

执行下面的命令后，Mapper 实现类一般会生成在 `target/generated-sources/annotations` 目录中：

```bash
mvn clean compile
```

### 5.2 Gradle 配置

使用 Gradle 时，需要把处理器声明为 `annotationProcessor`：

```groovy
dependencies {
    implementation "org.mapstruct:mapstruct:1.6.3"
    annotationProcessor "org.mapstruct:mapstruct-processor:1.6.3"
}
```

## 6. 第一个映射示例

先从字段名称和类型都相同的情况开始。假设有一个数据库实体：

```java
public class UserEntity {

    private Long id;
    private String username;
    private Integer age;

    // getter、setter 省略
}
```

接口需要返回一个 `UserDTO`：

```java
public class UserDTO {

    private Long id;
    private String username;
    private Integer age;

    // getter、setter 省略
}
```

只需要定义一个 Mapper 接口：

```java
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

@Mapper
public interface UserMapper {

    UserMapper INSTANCE = Mappers.getMapper(UserMapper.class);

    UserDTO toDTO(UserEntity entity);
}
```

使用时直接调用：

```java
UserEntity entity = new UserEntity();
entity.setId(1L);
entity.setUsername("Blizzard");
entity.setAge(18);

UserDTO dto = UserMapper.INSTANCE.toDTO(entity);

System.out.println(dto.getUsername()); // Blizzard
```

当源对象和目标对象的属性名称、类型一致时，MapStruct 会自动完成映射，不需要为每个字段编写 `@Mapping`。

## 7. 字段名称不一致

实际项目中，实体字段和接口字段往往不会完全一致。现在把 `UserDTO` 的 `username` 改成 `name`：

```java
public class UserDTO {

    private Long id;
    private String name;
    private Integer age;

    // getter、setter 省略
}
```

通过 `@Mapping` 指定字段对应关系：

```java
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    UserDTO toDTO(UserEntity entity);
}
```

这里需要分清两个属性：

- `source`：从源对象的哪个属性读取数据
- `target`：把数据写入目标对象的哪个属性

也就是把 `entity.getUsername()` 的结果写入 `dto.setName()`。

MapStruct 1.6.3 中，多个 `@Mapping` 可以直接重复使用，不必再额外包一层 `@Mappings`：

```java
@Mapping(target = "name", source = "username")
@Mapping(target = "createdTime", source = "createdAt")
UserDTO toDTO(UserEntity entity);
```

## 8. 在 Spring Boot 中使用

前面的 `Mappers.getMapper()` 适用于普通 Java 项目。在 Spring Boot 项目中，更推荐把 Mapper 注册为 Spring Bean。

```java
import org.mapstruct.Mapper;
import org.mapstruct.MappingConstants;

@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    UserDTO toDTO(UserEntity entity);
}
```

然后像注入普通 Service 一样注入 Mapper：

```java
@Service
public class UserService {

    private final UserMapper userMapper;

    public UserService(UserMapper userMapper) {
        this.userMapper = userMapper;
    }

    public UserDTO getUser(UserEntity entity) {
        return userMapper.toDTO(entity);
    }
}
```

`componentModel = "spring"` 也可以工作，使用 `MappingConstants.ComponentModel.SPRING` 则可以避免手写字符串。

## 9. 嵌套对象映射

假设用户实体中包含地址对象：

```java
public class AddressEntity {

    private String province;
    private String city;
    private String detail;

    // getter、setter 省略
}
```

```java
public class UserEntity {

    private Long id;
    private String username;
    private AddressEntity address;

    // getter、setter 省略
}
```

接口不想返回完整地址对象，只需要返回城市：

```java
public class UserDTO {

    private Long id;
    private String name;
    private String city;

    // getter、setter 省略
}
```

可以使用点号访问嵌套属性：

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    @Mapping(target = "city", source = "address.city")
    UserDTO toDTO(UserEntity entity);
}
```

MapStruct 生成的代码会对嵌套对象进行判空。即使 `address` 为 `null`，也不会因为直接调用 `address.getCity()` 而产生空指针异常。

如果目标对象同样是嵌套结构，也可以使用类似写法：

```java
@Mapping(target = "addressInfo.cityName", source = "address.city")
UserDTO toDTO(UserEntity entity);
```

## 10. 常用类型转换和格式化

MapStruct 内置了许多常见类型之间的转换，例如：

- 基本类型与包装类型
- 数值类型与字符串
- 枚举与字符串
- `Date` 与字符串
- Java 8 时间类型与字符串

下面扩展实体和 DTO：

```java
public class UserEntity {

    private Long id;
    private String username;
    private Integer age;
    private BigDecimal balance;
    private Date createdAt;

    // getter、setter 省略
}
```

```java
public class UserDTO {

    private Long id;
    private String name;
    private String age;
    private String balance;
    private String createdTime;

    // getter、setter 省略
}
```

Mapper 可以这样编写：

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    @Mapping(target = "age", source = "age", numberFormat = "#")
    @Mapping(target = "balance", source = "balance", numberFormat = "#0.00")
    @Mapping(
        target = "createdTime",
        source = "createdAt",
        dateFormat = "yyyy-MM-dd HH:mm:ss"
    )
    UserDTO toDTO(UserEntity entity);
}
```

其中：

- `numberFormat` 用于数值格式化
- `dateFormat` 用于日期和时间格式化
- 简单的 `Integer -> String` 即使不写 `numberFormat`，MapStruct 通常也能自动转换

格式化属于接口展示规则时，适合放在 Mapper 中；如果它包含复杂业务含义，则更适合放到领域服务中处理。

## 11. 集合映射

只要已经存在单个对象的映射方法，MapStruct 就能复用它完成集合映射：

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    UserDTO toDTO(UserEntity entity);

    List<UserDTO> toDTOList(List<UserEntity> entities);

    Set<UserDTO> toDTOSet(Set<UserEntity> entities);
}
```

生成的实现逻辑与下面的手写代码类似：

```java
List<UserDTO> result = new ArrayList<>(entities.size());
for (UserEntity entity : entities) {
    result.add(toDTO(entity));
}
```

当集合本身为 `null` 时，默认返回 `null`。如果项目希望返回空集合，可以统一配置空值映射策略。

对于 `Map` 类型，可以使用 `@MapMapping` 指定键和值的格式：

```java
@MapMapping(valueDateFormat = "yyyy-MM-dd")
Map<String, String> toStringMap(Map<String, Date> source);
```

## 12. 多个源对象映射到一个目标对象

有时页面数据来自多个对象。例如用户信息来自 `UserEntity`，操作人名称来自 `Operator`：

```java
public class Operator {

    private Long id;
    private String displayName;

    // getter、setter 省略
}
```

```java
public class UserDetailDTO {

    private Long id;
    private String name;
    private String operatorName;

    // getter、setter 省略
}
```

Mapper 方法可以接收多个参数：

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(target = "id", source = "user.id")
    @Mapping(target = "name", source = "user.username")
    @Mapping(target = "operatorName", source = "operator.displayName")
    UserDetailDTO toDetail(UserEntity user, Operator operator);
}
```

当存在多个源参数时，`source` 最好写成“参数名.属性名”，这样既能消除同名字段的歧义，也更容易阅读。

## 13. 更新已有对象

默认映射方法会创建一个新的目标对象。有些场景需要更新数据库中已经存在的实体，此时可以使用 `@MappingTarget`。

```java
public class UserUpdateCommand {

    private String username;
    private Integer age;
    private String city;

    // getter、setter 省略
}
```

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "address.city", source = "city")
    void update(
        UserUpdateCommand command,
        @MappingTarget UserEntity entity
    );
}
```

调用方式如下：

```java
UserEntity entity = userRepository.findById(id).orElseThrow();

userMapper.update(command, entity);

userRepository.save(entity);
```

`entity` 不会被替换，MapStruct 会修改传入实例的属性。

### 13.1 更新时忽略 null

处理局部更新接口时，通常希望请求中为 `null` 的字段保持原值，而不是把原值覆盖成 `null`。

```java
import org.mapstruct.BeanMapping;
import org.mapstruct.NullValuePropertyMappingStrategy;

@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @BeanMapping(
        nullValuePropertyMappingStrategy =
            NullValuePropertyMappingStrategy.IGNORE
    )
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    void update(
        UserUpdateCommand command,
        @MappingTarget UserEntity entity
    );
}
```

例如实体中原来的 `username` 是 `"Blizzard"`，请求中的 `username` 为 `null`，更新后仍然会保留 `"Blizzard"`。

需要注意：**忽略 null 和把字段显式更新为 null 是两种不同的业务语义**。如果接口同时需要表达这两种状态，仅靠普通 Java 字段通常不够，应在请求模型中增加额外状态。

## 14. 枚举映射

两个枚举常量名称相同时，MapStruct 可以自动映射：

```java
public enum UserStatus {
    ACTIVE,
    DISABLED
}

public enum UserStatusDTO {
    ACTIVE,
    DISABLED
}
```

```java
UserStatusDTO toStatusDTO(UserStatus status);
```

如果枚举常量名称不同，使用 `@ValueMapping`：

```java
public enum UserStatus {
    ACTIVE,
    DISABLED,
    DELETED
}

public enum UserStatusDTO {
    ENABLED,
    FORBIDDEN,
    UNKNOWN
}
```

```java
import org.mapstruct.ValueMapping;

@ValueMapping(source = "ACTIVE", target = "ENABLED")
@ValueMapping(source = "DISABLED", target = "FORBIDDEN")
@ValueMapping(source = "DELETED", target = "UNKNOWN")
UserStatusDTO toStatusDTO(UserStatus status);
```

显式列出枚举映射有一个很实用的好处：源枚举增加新值后，如果没有对应规则，编译阶段就能提醒开发者补充处理逻辑。

## 15. 自定义转换方法

内置转换无法满足需求时，可以在 Mapper 中编写默认方法。例如，接口返回手机号时需要脱敏：

```java
import org.mapstruct.Named;

@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface UserMapper {

    @Mapping(
        target = "mobile",
        source = "mobile",
        qualifiedByName = "maskMobile"
    )
    UserDTO toDTO(UserEntity entity);

    @Named("maskMobile")
    default String maskMobile(String mobile) {
        if (mobile == null || mobile.length() != 11) {
            return mobile;
        }
        return mobile.substring(0, 3)
            + "****"
            + mobile.substring(7);
    }
}
```

`qualifiedByName` 用于指定本次映射应该调用哪个自定义方法。当同一种源类型和目标类型存在多个转换方法时，这种方式尤其有用。

如果转换逻辑需要复用，也可以放到独立类中：

```java
public class MobileConverter {

    @Named("maskMobile")
    public String mask(String mobile) {
        // 脱敏逻辑
        return mobile;
    }
}
```

然后通过 `uses` 引入：

```java
@Mapper(
    componentModel = MappingConstants.ComponentModel.SPRING,
    uses = MobileConverter.class
)
public interface UserMapper {

    @Mapping(
        target = "mobile",
        source = "mobile",
        qualifiedByName = "maskMobile"
    )
    UserDTO toDTO(UserEntity entity);
}
```

## 16. 反向映射

当两个对象需要双向转换时，可以使用 `@InheritInverseConfiguration` 复用反向规则。

```java
public class ProductEntity {

    private Long id;
    private String name;

    // getter、setter 省略
}
```

```java
public class ProductDTO {

    private Long id;
    private String productName;

    // getter、setter 省略
}
```

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface ProductMapper {

    @Mapping(target = "productName", source = "name")
    ProductDTO toDTO(ProductEntity entity);

    @InheritInverseConfiguration(name = "toDTO")
    ProductEntity toEntity(ProductDTO dto);
}
```

MapStruct 会把正向的 `name -> productName` 规则反转为 `productName -> name`。

对于表达式、常量、默认值和复杂嵌套映射，不要完全依赖自动反转，最好检查生成代码，并为关键转换编写测试。

## 17. 默认值、常量和表达式

### 17.1 默认值

当源字段为 `null` 时，可以通过 `defaultValue` 设置默认值：

```java
@Mapping(
    target = "nickname",
    source = "nickname",
    defaultValue = "未设置"
)
UserDTO toDTO(UserEntity entity);
```

### 17.2 常量

无论源对象是什么，都给目标字段设置固定值：

```java
@Mapping(target = "source", constant = "USER_CENTER")
UserDTO toDTO(UserEntity entity);
```

### 17.3 Java 表达式

也可以通过 `expression` 编写 Java 表达式：

```java
@Mapping(
    target = "displayName",
    expression = "java(entity.getId() + \"-\" + entity.getUsername())"
)
UserDTO toDTO(UserEntity entity);
```

表达式虽然灵活，但 MapStruct 不会在生成代码之前验证表达式内容，错误通常要等编译生成类时才会暴露。复杂逻辑更推荐写成普通方法，再通过 `qualifiedByName` 或 `uses` 调用。

## 18. 忽略字段和严格检查

某些目标字段不应该由当前 Mapper 赋值，可以显式忽略：

```java
@Mapping(target = "password", ignore = true)
@Mapping(target = "lastLoginTime", ignore = true)
UserDTO toDTO(UserEntity entity);
```

在多人协作项目中，建议把未映射的目标字段当作编译错误：

```java
import org.mapstruct.ReportingPolicy;

@Mapper(
    componentModel = MappingConstants.ComponentModel.SPRING,
    unmappedTargetPolicy = ReportingPolicy.ERROR
)
public interface UserMapper {

    UserDTO toDTO(UserEntity entity);
}
```

这样，当 DTO 新增字段却忘记补充映射时，项目会在编译阶段失败，而不是悄悄返回 `null`。

多个 Mapper 可以通过 `@MapperConfig` 共享配置：

```java
@MapperConfig(
    componentModel = MappingConstants.ComponentModel.SPRING,
    unmappedTargetPolicy = ReportingPolicy.ERROR
)
public interface CentralMapperConfig {
}
```

```java
@Mapper(config = CentralMapperConfig.class)
public interface UserMapper {

    UserDTO toDTO(UserEntity entity);
}
```

## 19. 看一眼生成的代码

对于下面的 Mapper：

```java
@Mapper
public interface UserMapper {

    @Mapping(target = "name", source = "username")
    UserDTO toDTO(UserEntity entity);
}
```

MapStruct 生成的实现大致如下：

```java
public class UserMapperImpl implements UserMapper {

    @Override
    public UserDTO toDTO(UserEntity entity) {
        if (entity == null) {
            return null;
        }

        UserDTO dto = new UserDTO();
        dto.setName(entity.getUsername());
        dto.setId(entity.getId());
        dto.setAge(entity.getAge());

        return dto;
    }
}
```

这也是 MapStruct 与运行时反射工具的主要区别：它生成的是可以直接阅读和调试的 Java 代码。

当映射结果与预期不一致时，查看 `target/generated-sources/annotations` 中的实现类，通常比反复猜测注解规则更高效。

## 20. 编写一个简单测试

对象映射也是业务边界的一部分，关键 Mapper 建议补充单元测试：

```java
class UserMapperTest {

    private final UserMapper mapper = UserMapper.INSTANCE;

    @Test
    void shouldMapUserEntityToDTO() {
        UserEntity entity = new UserEntity();
        entity.setId(1L);
        entity.setUsername("Blizzard");
        entity.setAge(18);

        UserDTO dto = mapper.toDTO(entity);

        assertEquals(1L, dto.getId());
        assertEquals("Blizzard", dto.getName());
        assertEquals(18, dto.getAge());
    }
}
```

至少应覆盖以下情况：

- 正常对象映射
- 源对象为 `null`
- 嵌套对象为 `null`
- 日期、数值和枚举转换
- `@MappingTarget` 更新时的 null 处理

## 21. 常见问题

### 21.1 找不到 Mapper 实现类

如果出现 `ClassNotFoundException`，或者 IDE 提示找不到 `UserMapperImpl`，优先检查：

1. 是否引入了 `mapstruct-processor`
2. Maven 或 Gradle 是否启用了注解处理
3. IDE 是否关闭了 Annotation Processing
4. 是否真正执行过编译

可以先运行：

```bash
mvn clean compile
```

然后检查 `target/generated-sources/annotations`。

### 21.2 使用 Lombok 后没有识别到属性

MapStruct 和 Lombok 都依赖编译期注解处理。如果两者一起使用时出现属性不存在、没有 getter 等错误，需要检查注解处理器配置和处理顺序。

新项目可以减少对 Lombok 的依赖，或者按照 MapStruct 官方文档中的 Lombok 集成方式配置 `lombok-mapstruct-binding`。

### 21.3 不要把业务逻辑全部塞进 Mapper

Mapper 适合处理：

- 字段复制和重命名
- 展示格式转换
- 对象结构调整
- 简单值转换

涉及数据库查询、权限判断、状态流转等业务逻辑时，应该放在 Service 或领域层中。Mapper 的职责越明确，生成代码和测试就越容易维护。

## 22. 总结

MapStruct 最核心的使用方式可以归纳为：

| 场景 | 用法 |
| --- | --- |
| 同名同类型字段 | 直接声明映射方法 |
| 字段名不同 | `@Mapping(source = "...", target = "...")` |
| 嵌套属性 | `source = "address.city"` |
| 日期和数字格式化 | `dateFormat`、`numberFormat` |
| 集合转换 | 声明 `List<A> -> List<B>` 方法 |
| 多对象组装 | Mapper 方法接收多个源参数 |
| 更新已有对象 | `@MappingTarget` |
| 更新时忽略 null | `NullValuePropertyMappingStrategy.IGNORE` |
| 枚举值不同 | `@ValueMapping` |
| 自定义转换 | `@Named`、`qualifiedByName`、`uses` |
| 反向转换 | `@InheritInverseConfiguration` |
| 防止漏字段 | `unmappedTargetPolicy = ReportingPolicy.ERROR` |

MapStruct 并不是让对象转换代码彻底消失，而是把手写转换代码变成**可声明、可生成、可检查的映射规则**。在 DTO、VO 较多的项目中，它能够明显减少重复代码，同时让字段变更更早地暴露在编译阶段。

## 参考资料

- [MapStruct 1.6.3 官方参考文档](https://mapstruct.org/documentation/stable/reference/html/)
- [MapStruct 最详细的使用教程，别再用 BeanUtils.copyProperties()](https://blog.csdn.net/qq_40194399/article/details/110162124)
