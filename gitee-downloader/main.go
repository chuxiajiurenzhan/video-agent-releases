package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var manifestURL string

type manifest struct {
	Version         string `json:"version"`
	InstallerName   string `json:"installerName"`
	InstallerSize   int64  `json:"installerSize"`
	InstallerSHA256 string `json:"installerSha256"`
	BaseURL         string `json:"baseUrl"`
	Parts           []part `json:"parts"`
}

type part struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func main() {
	if err := run(); err != nil {
		fmt.Printf("\n下载失败：%v\n", err)
		fmt.Println("请检查网络后重新运行；已完成的分片会自动复用。")
		fmt.Print("按回车键退出...")
		_, _ = fmt.Scanln()
		os.Exit(1)
	}
}

func run() error {
	if manifestURL == "" {
		return errors.New("下载器没有配置版本清单地址")
	}
	fmt.Println("影迹Studio Gitee 国内镜像下载器")
	fmt.Println("正在获取版本信息...")

	client := &http.Client{Timeout: 0}
	var spec manifest
	if err := getJSON(client, manifestURL, &spec); err != nil {
		return fmt.Errorf("获取版本清单：%w", err)
	}
	if err := validateManifest(spec); err != nil {
		return err
	}

	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return fmt.Errorf("获取缓存目录：%w", err)
	}
	partDir := filepath.Join(cacheRoot, "YingJiStudio", "downloads", "v"+spec.Version)
	if err := os.MkdirAll(partDir, 0o755); err != nil {
		return fmt.Errorf("创建缓存目录：%w", err)
	}

	for index, item := range spec.Parts {
		partPath := filepath.Join(partDir, item.Name)
		if matchesFile(partPath, item.Size, item.SHA256) {
			fmt.Printf("[%d/%d] 已存在：%s\n", index+1, len(spec.Parts), item.Name)
			continue
		}
		fmt.Printf("[%d/%d] 正在下载：%s\n", index+1, len(spec.Parts), item.Name)
		partURL := strings.TrimRight(spec.BaseURL, "/") + "/" + url.PathEscape(item.Name)
		if err := downloadFile(client, partURL, partPath, item.Size, item.SHA256); err != nil {
			return fmt.Errorf("下载 %s：%w", item.Name, err)
		}
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("获取用户目录：%w", err)
	}
	downloadsDir := filepath.Join(homeDir, "Downloads")
	if err := os.MkdirAll(downloadsDir, 0o755); err != nil {
		return fmt.Errorf("创建下载目录：%w", err)
	}
	installerPath := filepath.Join(downloadsDir, spec.InstallerName)
	if !matchesFile(installerPath, spec.InstallerSize, spec.InstallerSHA256) {
		fmt.Println("正在合并并校验安装包...")
		if err := combineParts(spec, partDir, installerPath); err != nil {
			return err
		}
	}

	fmt.Printf("安装包已就绪：%s\n", installerPath)
	fmt.Println("正在启动安装程序...")
	if err := exec.Command(installerPath).Start(); err != nil {
		return fmt.Errorf("启动安装程序：%w", err)
	}
	return nil
}

func validateManifest(spec manifest) error {
	if spec.Version == "" || strings.ContainsAny(spec.Version, `/\\`) {
		return errors.New("版本清单中的版本号无效")
	}
	if filepath.Base(spec.InstallerName) != spec.InstallerName || !strings.HasSuffix(strings.ToLower(spec.InstallerName), ".exe") {
		return errors.New("版本清单中的安装包名称无效")
	}
	if spec.InstallerSize <= 0 || !validSHA256(spec.InstallerSHA256) {
		return errors.New("版本清单中的安装包校验信息无效")
	}
	baseURL, err := url.Parse(spec.BaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" {
		return errors.New("版本清单中的下载地址无效")
	}
	if len(spec.Parts) == 0 {
		return errors.New("版本清单没有安装包分片")
	}
	var totalSize int64
	for _, item := range spec.Parts {
		if filepath.Base(item.Name) != item.Name || item.Size <= 0 || !validSHA256(item.SHA256) {
			return fmt.Errorf("版本清单中的分片信息无效：%s", item.Name)
		}
		totalSize += item.Size
	}
	if totalSize != spec.InstallerSize {
		return errors.New("版本清单中的分片总大小不匹配")
	}
	return nil
}

func validSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func getJSON(client *http.Client, address string, target any) error {
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "YingJiStudio-Gitee-Downloader/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func downloadFile(client *http.Client, address, targetPath string, expectedSize int64, expectedSHA string) error {
	temporaryPath := targetPath + ".download"
	_ = os.Remove(temporaryPath)
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "YingJiStudio-Gitee-Downloader/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	target, err := os.Create(temporaryPath)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(target, resp.Body)
	closeErr := target.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if !matchesFile(temporaryPath, expectedSize, expectedSHA) {
		return errors.New("文件大小或 SHA-256 校验失败")
	}
	_ = os.Remove(targetPath)
	return os.Rename(temporaryPath, targetPath)
}

func combineParts(spec manifest, partDir, installerPath string) error {
	temporaryPath := installerPath + ".download"
	_ = os.Remove(temporaryPath)
	target, err := os.Create(temporaryPath)
	if err != nil {
		return fmt.Errorf("创建安装包：%w", err)
	}
	for _, item := range spec.Parts {
		source, openErr := os.Open(filepath.Join(partDir, item.Name))
		if openErr != nil {
			_ = target.Close()
			return fmt.Errorf("打开分片 %s：%w", item.Name, openErr)
		}
		_, copyErr := io.Copy(target, source)
		_ = source.Close()
		if copyErr != nil {
			_ = target.Close()
			return fmt.Errorf("合并分片 %s：%w", item.Name, copyErr)
		}
	}
	if err := target.Close(); err != nil {
		return err
	}
	if !matchesFile(temporaryPath, spec.InstallerSize, spec.InstallerSHA256) {
		return errors.New("合并后的安装包 SHA-256 校验失败")
	}
	_ = os.Remove(installerPath)
	return os.Rename(temporaryPath, installerPath)
}

func matchesFile(filePath string, expectedSize int64, expectedSHA string) bool {
	metadata, err := os.Stat(filePath)
	if err != nil || metadata.Size() != expectedSize {
		return false
	}
	file, err := os.Open(filePath)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false
	}
	return strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expectedSHA)
}
