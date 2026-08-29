cmake_minimum_required(VERSION 3.22.1)
project("waveforge_android")

# JNI 桥：把 Kotlin 的 startNodeWithArguments 调用转到 node::Start。
add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

# libnode 头文件（来自 nodejs-mobile 发布包 include/ 目录）。
include_directories(libnode/include/node/)

# 导入预编译的 nodejs-mobile 运行时。
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(native-lib
    libnode
    ${log-lib})
